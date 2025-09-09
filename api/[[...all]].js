// api/[[...all]].js
const express = require('express');
const apiRouter = require('../backend/src/api'); // <-- a te express Router-ed

const app = express();

// Ha a routered /rates, /logs stb. útvonalakat vár, jó eséllyel itt még /api/ prefix van.
// Vercelen a req.url általában tartalmazza a /api/ prefixet – vágjuk le:
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
  next();
});

app.use(apiRouter);

module.exports = (req, res) => app(req, res);
