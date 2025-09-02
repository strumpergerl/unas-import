// backend/src/server.js
const express = require('express');
const path = require('path');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

// REST API
app.use('/api', api);

// Statikus frontend
const staticPath = path.join(__dirname, '../public');
app.use(express.static(staticPath));
app.get('*', (_req, res) => res.sendFile(path.join(staticPath, 'index.html')));

app.listen(PORT, () => console.log(`Server fut a ${PORT}-on`));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
process.on('unhandledRejection', (reason, p) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});