// backend/src/server.js
const express = require('express');
const path = require('path');
const api = require('./api');
const { serve } = require("inngest/express");
const inngest = require("./inngest");
const { runImport } = require("./scheduler");


const app = express();
const PORT = process.env.PORT || 3000;

// Inngest endpoint először, hogy publikus legyen!
app.use("/api/inngest", serve(inngest, [runImport]));

// REST API
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/inngest')) return next();
  return api(req, res, next);
});

// Statikus frontend
const staticPath = path.join(__dirname, '../public');
app.use(express.static(staticPath));
app.get('*', (_req, res) => res.sendFile(path.join(staticPath, 'index.html')));

app.listen(PORT, () => console.log(`Server fut a ${PORT}-on`));

// Egészségügyi ellenőrzés
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
process.on('unhandledRejection', (reason, p) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});