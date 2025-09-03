// api/[...all].js
const serverless = require('serverless-http');
const express = require('express');

// a saját routered:
const apiRouter = require('../backend/src/api'); // <-- ez a /backend/src/api/index.js

const app = express();

// FONTOS: ne tegyél ide plusz '/api' prefixet!
// A Vercel már eleve az '/api/*' útvonalat irányítja ide.
app.use(apiRouter);

module.exports = serverless(app);
