// backend/src/api/index.js
require('../bootstrapEnv');
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
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const fsSync = require('fs');
const pathMod = require('path');
const PROCESSES_FILE = pathMod.resolve(__dirname, '../config/processes.json');

const candidates = [
  path.resolve(__dirname, '../../.env'), // monorepo gyökér
  path.resolve(__dirname, '../.env'),    // backend/.env
  path.resolve(process.cwd(), '.env')    // futtatási CWD
];

for (const p of candidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    console.log(`[ENV] Loaded: ${p}`); // NEM logol kulcsokat!
    break;
  }
}

/** Visszaadja a process configot azonosító alapján. */
function getProcessConfigById(processId) {
  if (!processId) return null;
  return Array.isArray(processes)
    ? processes.find(p => p.processId === processId)
    : null;
}

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
    
    // ütemező újraindítás az új konfigurációval
    if (typeof scheduleProcesses === 'function') {
      scheduleProcesses(processes);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Folyamat futtatása
router.post('/run', async (req, res) => {
  try {
    const { processId } = req.body || {};
    if (!processId) return res.status(400).json({ success: false, error: 'processId required' });

    console.log('[RUN] processId:', processId, 'available:', processes.map(p => p.processId));

    const processConfig = getProcessConfigById(processId); // a te függvényed
    if (!processConfig) return res.status(404).json({ success: false, error: `Process not found: ${processId}` });

    const t0 = Date.now();
    const dl = await downloadFile(processConfig.feedUrl);
    const rawSize = dl?.length || 0;

    const parsed = await parseData(dl, processConfig);   // Array
    const parsedCount = Array.isArray(parsed) ? parsed.length : 0;
    console.log('[DEBUG] parsed sample:', parsed?.[0], 'count=', parsedCount);

    const transformed = await transformData(parsed, processConfig); // Array
    const transformedCount = Array.isArray(transformed) ? transformed.length : 0;
    console.log('[DEBUG] transformed sample:', transformed?.[0], 'count=', transformedCount);

    // Opcionális „feltöltésre alkalmas” szűrő: csak ahol van SKU
    const withSku = (transformed || []).filter(x => x?.sku || x?.Sku || x?.SKU);
    const uploadCandidates = withSku.length;

    let uploadStats = null;

    // DRY-run esetén ne töltsünk
    if (!processConfig.dryRun) {
      await uploadToUnas(withSku, processConfig);
    }

    const dt = Date.now() - t0;
    return res.json({
      success: true,
      stats: {
        rawSize,
        parsedCount,
        transformedCount,
        uploadCandidates,
        durationMs: dt,
        upload: uploadStats,
      },
      sample: {
        parsed: parsed?.[0] || null,
        transformed: transformed?.[0] || null,
      },
    });
  } catch (e) {
    console.error('❌ /run hiba:', e);
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// Folyamat törlése
router.delete('/config/:processId', (req, res) => {
  try {
    const { processId } = req.params;
    if (!processId) {
      return res.status(400).json({ ok: false, error: 'processId required' });
    }

    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(__dirname, '../config/processes.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const list = JSON.parse(raw);

    const idx = list.findIndex(p => p.processId === processId);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'Process not found', processId });
    }

    const [removed] = list.splice(idx, 1);
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');

    // memóriabeli processes frissítése
    processes.length = 0;
    list.forEach(p => processes.push(p));

    // ütemező újraindítása
    if (typeof scheduleProcesses === 'function') {
      scheduleProcesses(processes);
    }

    return res.json({ ok: true, removed });
  } catch (e) {
    console.error('[DELETE /api/config/:processId] error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
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

// Fejlesztői végpontok
const testUnas = require('./testUnas');
router.use('/test/unas', testUnas);

module.exports = router;