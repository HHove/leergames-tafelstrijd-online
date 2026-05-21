const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4175);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(__dirname);
const rooms = new Map();

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeCode() {
  let code = "";
  do {
    code = crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function makeQuestion(tables) {
  const a = rand(tables.length ? tables : [1]);
  const b = Math.floor(Math.random() * 10) + 1;
  return { id: makeId(), a, b, answer: a * b, text: `${a} × ${b}` };
}

function finishScore(rounds) {
  return Math.max(120, rounds * 14);
}

function cleanName(name) {
  const cleaned = String(name || "").trim().slice(0, 24);
  return cleaned || "Speler";
}

function cleanSkin(skin) {
  return String(skin || "horse").slice(0, 32);
}

function cleanTables(tables) {
  const allowed = Array.isArray(tables)
    ? tables.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)
    : [];
  return [...new Set(allowed)].sort((a, b) => a - b).slice(0, 10);
}

function cleanRounds(rounds) {
  return [10, 20, 30].includes(Number(rounds)) ? Number(rounds) : 20;
}

function publicRoom(room) {
  const winner = [...room.players].sort((a, b) => b.score - a.score)[0] || null;
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    tables: room.tables,
    rounds: room.rounds,
    qNum: room.qNum,
    q: room.status === "game" && room.q ? { text: room.q.text } : null,
    players: room.players,
    answeredIds: Object.keys(room.answered || {}),
    feedbackByPlayer: room.feedbackByPlayer || {},
    questionEndsAt: room.questionEndsAt || 0,
    finish: finishScore(room.rounds),
    msg: room.msg,
    feedbackColor: room.feedbackColor,
    locked: room.locked,
    winnerId: winner ? winner.id : null,
    updatedAt: room.updatedAt,
  };
}

function touch(room) {
  room.updatedAt = Date.now();
}

function scheduleQuestionTimeout(room) {
  clearTimeout(room.questionTimer);
  room.questionStartedAt = Date.now();
  room.questionEndsAt = room.questionStartedAt + 9000;
  const questionId = room.q.id;
  room.questionTimer = setTimeout(() => advanceRoom(room, questionId, { timeout: true }), 9000);
}

function startRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.questionTimer);
  room.players = room.players.map((player) => ({
    ...player,
    score: 0,
    streak: 0,
    answers: 0,
  }));
  room.status = "game";
  room.qNum = 1;
  room.q = makeQuestion(room.tables);
  room.answered = {};
  room.feedbackByPlayer = {};
  room.msg = "";
  room.feedbackColor = "neutral";
  room.locked = false;
  touch(room);
  scheduleQuestionTimeout(room);
}

function advanceRoom(room, questionId, options = {}) {
  if (room.status !== "game" || !room.q || room.q.id !== questionId) return;
  clearTimeout(room.timer);
  clearTimeout(room.questionTimer);

  if (options.timeout) {
    room.players = room.players.map((player) => (
      room.answered[player.id] ? player : { ...player, streak: 0 }
    ));
  }

  if (room.players.some((player) => player.score >= finishScore(room.rounds)) || room.qNum >= room.rounds) {
    room.status = "result";
    room.locked = false;
    room.msg = "";
    room.feedbackColor = "neutral";
    room.questionEndsAt = 0;
    touch(room);
    return;
  }

  room.qNum += 1;
  room.q = makeQuestion(room.tables);
  room.answered = {};
  room.feedbackByPlayer = {};
  room.msg = "";
  room.feedbackColor = "neutral";
  room.locked = false;
  touch(room);
  scheduleQuestionTimeout(room);
}

function answerRoom(room, clientId, answer) {
  if (room.status !== "game") return { error: "Deze room is nog niet gestart." };
  if (room.locked) return { error: "Wacht op de volgende vraag." };
  if (room.answered[clientId]) return { error: "Je antwoord is al binnen." };

  const player = room.players.find((item) => item.id === clientId);
  if (!player) return { error: "Je zit niet in deze room." };

  const ok = Number(answer) === room.q.answer;
  const seconds = Math.floor((Date.now() - room.questionStartedAt) / 1000);
  const speedBonus = ok ? Math.max(0, 6 - seconds) : 0;
  const points = ok ? 10 + Math.min(player.streak * 2, 10) + speedBonus : 0;
  const nextStreak = ok ? player.streak + 1 : 0;
  const bonus = ok && nextStreak % 3 === 0 ? 20 : 0;
  const total = points + bonus;

  room.players = room.players.map((item) => {
    if (item.id !== clientId) return item;
    return {
      ...item,
      score: item.score + total,
      streak: nextStreak,
      answers: item.answers + 1,
    };
  });

  room.answered[clientId] = { ok, points: total, answer: Number(answer) };
  room.feedbackByPlayer[clientId] = {
    ok,
    color: ok ? "green" : "orange",
    msg: ok ? `✅ +${total}` : `❌ ${room.q.answer}`,
  };
  room.feedbackColor = ok ? "green" : "orange";
  room.msg = ok ? `✅ ${player.name}: +${total}` : `❌ ${player.name}: ${room.q.answer}`;
  touch(room);

  if (room.players.every((item) => room.answered[item.id])) {
    room.locked = true;
    const questionId = room.q.id;
    room.timer = setTimeout(() => advanceRoom(room, questionId), 900);
  }

  return { room: publicRoom(room) };
}

function pruneRooms() {
  const maxAge = 1000 * 60 * 60 * 4;
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > maxAge) {
      clearTimeout(room.timer);
      clearTimeout(room.questionTimer);
      rooms.delete(code);
    }
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Te veel data.");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function notFound(res) {
  sendJson(res, 404, { error: "Niet gevonden." });
}

async function handleApi(req, res, url) {
  pruneRooms();

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(req);
    const clientId = makeId();
    const code = makeCode();
    const tables = cleanTables(body.tables);
    const room = {
      code,
      hostId: clientId,
      status: "lobby",
      tables: tables.length ? tables : [1, 2, 3, 4, 5],
      rounds: cleanRounds(body.rounds),
      qNum: 1,
      q: null,
      msg: "",
      feedbackColor: "neutral",
      locked: false,
      answered: {},
      feedbackByPlayer: {},
      timer: null,
      questionTimer: null,
      questionStartedAt: 0,
      questionEndsAt: 0,
      updatedAt: Date.now(),
      players: [{
        id: clientId,
        name: cleanName(body.name),
        skin: cleanSkin(body.skin),
        score: 0,
        streak: 0,
        answers: 0,
      }],
    };
    rooms.set(code, room);
    sendJson(res, 200, { clientId, room: publicRoom(room) });
    return;
  }

  const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})(?:\/(join|start|answer))?$/);
  if (!match) {
    notFound(res);
    return;
  }

  const code = match[1];
  const action = match[2] || "state";
  const room = rooms.get(code);
  if (!room) {
    sendJson(res, 404, { error: "Room bestaat niet meer." });
    return;
  }

  if (req.method === "GET" && action === "state") {
    touch(room);
    sendJson(res, 200, { room: publicRoom(room) });
    return;
  }

  if (req.method !== "POST") {
    notFound(res);
    return;
  }

  const body = await readJson(req);

  if (action === "join") {
    if (room.status !== "lobby") {
      sendJson(res, 409, { error: "Deze room is al gestart." });
      return;
    }
    const clientId = makeId();
    room.players.push({
      id: clientId,
      name: cleanName(body.name),
      skin: cleanSkin(body.skin),
      score: 0,
      streak: 0,
      answers: 0,
    });
    touch(room);
    sendJson(res, 200, { clientId, room: publicRoom(room) });
    return;
  }

  if (action === "start") {
    if (body.clientId !== room.hostId) {
      sendJson(res, 403, { error: "Alleen de host kan starten." });
      return;
    }
    if (room.players.length < 2) {
      sendJson(res, 409, { error: "Wacht op minimaal twee spelers." });
      return;
    }
    startRoom(room);
    sendJson(res, 200, { room: publicRoom(room) });
    return;
  }

  if (action === "answer") {
    const result = answerRoom(room, body.clientId, body.answer);
    if (result.error) {
      sendJson(res, 409, result);
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  notFound(res);
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const type = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Serverfout." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Leergames multiplayer draait op http://${HOST}:${PORT}/`);
});
