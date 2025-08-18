// backend/src/api/index.js
const devProductsRouter = require('./devProducts');

const express = require('express');
const downloadFile = require('../core/downloadFile');
const parseData   = require('../core/parseData');
const transformData = require('../core/transformData');
const uploadToUnas = require('../core/uploadToUnas');
const shops    = require('../config/shops.json');
const processes = require('../config/processes.json');
const rateUpdater = require('../utils/rateUpdater'); 
const { scheduleProcesses } = require('../scheduler');
const { getLogs } = require('../runner');

const router = express.Router();
const logs = [];

// JSON body parsing
router.use(express.json());

// Config beolvasása
router.get('/config', (req, res) => {
  res.json({ shops, processes });
});

// Config mentése (POST)
router.post('/config', (req, res) => {
  const { processes: newProcesses } = req.body;
  const fs = require('fs');
  const path = require('path');
  const filePath = path.resolve(__dirname, '../config/processes.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(newProcesses, null, 2), 'utf-8');
    // memóriabeli frissítés
    processes.length = 0;
    newProcesses.forEach(p => processes.push(p));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Folyamat futtatása
router.post('/run', async (req, res) => {
  console.log('BODY:', req.body);
  const { processId } = req.body;
  const proc = processes.find(p => p.processId === processId);
  if (!proc) return res.status(404).json({ error: 'Process nem található' });

  const shop = shops.find(s => s.shopId === proc.shopId);
  try {
    logs.push(`${new Date().toISOString()} - ${proc.displayName} start`);

    const buf = await downloadFile(proc.feedUrl);
    logs.push(`Letöltve: ${proc.feedUrl}`);

    const recs = await parseData(buf, proc.feedUrl);
    logs.push(`Parsed: ${recs.length} rekord`);

    const trans = await transformData(recs, proc);
    logs.push(`Átalakítva`);

    await uploadToUnas(trans, proc, shop);
    logs.push(`Feltöltés kész${proc.dryRun ? ' (dryRun)' : ''}`);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ /run hiba:', err)
    logs.push(`Hiba: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Logok lekérdezése
router.get('/logs', (req, res) => {
  res.json(getLogs());
});

// Árfolyamok lekérése
router.get('/rates', (req, res) => {
  const { rates, lastUpdated } = rateUpdater.getRates();
  res.json({ rates, lastUpdated });
});

// Ütemezés indítása
scheduleProcesses(processes);

router.use('/dev', devProductsRouter); 

module.exports = router;