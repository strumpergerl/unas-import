// backend/src/index.js
require('./bootstrapEnv');

const path = require('path');
const fs = require('fs');
const express = require('express');

const apiRouter = require('./api'); // ./api/index.js-t tölti be
const { scheduleProcesses, scheduleLogPrune } = require('./scheduler');

// Árfolyam frissítő (védetten hívjuk, ha elérhető)
let rateUpdater = null;
try {
  rateUpdater = require('./utils/rateUpdater');
} catch (e) {
  console.warn('[BACKEND] rateUpdater nem elérhető (utils/rateUpdater).');
}

const app = express();

// API
app.use('/api', apiRouter);

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

// Statikus frontend (vite build a backend/public mappába megy)
const PUBLIC_DIR = path.resolve(__dirname, '../public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[BACKEND] Server fut a ${PORT}-on`);

  // Árfolyamok: indításkor / ütemezve
  try {
    if (rateUpdater) {
      if (typeof rateUpdater.start === 'function') {
        rateUpdater.start();
      } else if (typeof rateUpdater.init === 'function') {
        rateUpdater.init();
      } else if (typeof rateUpdater.updateNow === 'function') {
        rateUpdater.updateNow();
      }
      console.log('[BACKEND] rateUpdater inicializálva');
    }
  } catch (e) {
    console.error('[BACKEND] rateUpdater hiba:', e?.message || e);
  }

  // Ütemezők
  try {
    if (typeof scheduleProcesses === 'function') scheduleProcesses();
    if (typeof scheduleLogPrune === 'function') scheduleLogPrune();
  } catch (e) {
    console.error('[BACKEND] scheduler hiba:', e?.message || e);
  }
});

module.exports = app;
