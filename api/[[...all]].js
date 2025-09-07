// api/[[...all]].js
console.log('[[...all]] handler loaded');
const express = require('express');
const apiRouter = require('../backend/src/api');

const app = express();

// (Opcionális) /api prefix levágása, ha így érkezik a req.url
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
  next();
});

// Mountold az Express routert ( /config, /rates, /logs, stb. )
app.use(apiRouter);

// Vercel Node handler: (req, res) -> app(req, res)
module.exports = (req, res) => app(req, res);
