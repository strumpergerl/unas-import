// api/[[...all]].js
const serverless = require('serverless-http');
const express = require('express');
const apiRouter = require('../backend/src/api');

const app = express();

// 1) Ha a kérés '/api/...' prefixszel jön, szedjük le:
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) req.url = req.url.slice(4); // '/api' levágása
  next();
});

// 2) Mount prefix nélkül — így a routered '/config', '/logs', stb. útvonalai illeszkednek
app.use(apiRouter);

module.exports = serverless(app);
