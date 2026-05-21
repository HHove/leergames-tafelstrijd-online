# Leergames online zetten

Deze versie heeft een Node-server nodig, omdat multiplayer rooms online gedeeld worden.

## Snelste route: Render

1. Maak een gratis account op https://render.com.
2. Zet deze map in een GitHub-repository.
3. Kies in Render: **New +** -> **Web Service**.
4. Selecteer je repository.
5. Render gebruikt automatisch:
   - Build command: `npm install`
   - Start command: `npm start`
6. Na de deploy krijg je een `https://...onrender.com` link.

## Spelen

1. Host opent de online link.
2. Klik op **Maak game**.
3. Deel de link die in de lobby verschijnt.
4. Andere spelers openen die link en klikken op **Join game**.
5. Host start het spel zodra iedereen in de lobby staat.

Let op: rooms blijven in het geheugen van de server. Als de gratis server slaapt of opnieuw start, verdwijnen bestaande rooms.
