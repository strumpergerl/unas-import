// api/[[...all]].js
console.log('[[...all]] handler loaded');
const serverless = require('serverless-http');
const express = require('express');
const apiRouter = require('../backend/src/api');

const app = express();

try {
  // 1) Ha a kérés '/api/...' prefixszel jön, szedjük le:
  app.use((req, _res, next) => {
    console.log('[[...all]] request:', req.method, req.url);
    if (req.url.startsWith('/api/')) req.url = req.url.slice(4); // '/api' levágása
    next();
  });


  // Minimal health route for debug
  app.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // 2) Mount prefix nélkül — így a routered '/config', '/logs', stb. útvonalai illeszkednek
  app.use(apiRouter);

} catch (e) {
  console.error('[[...all]] FATAL ERROR:', e);
  throw e;
}

module.exports = serverless(app);
