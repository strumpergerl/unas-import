// backend/src/api/index.js
require('../bootstrapEnv');
const express = require('express');
const downloadFile = require('../core/downloadFile');
const parseData = require('../core/parseData');
const transformData = require('../core/transformData');
const uploadToUnas = require('../core/uploadToUnas');
const rateUpdater = require('../utils/rateUpdater');
const { getLogs } = require('../runner');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { db } = require('../db/firestore');

// --- (opcionális) egyszerű cache a /unas/fields-hez ---
const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 óra
function putCache(key, value) { CACHE.set(key, { value, ts: Date.now() }); }
function getCache(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.value;
}

// --- ENV betöltés (monorepo / backend futtatás) ---
const candidates = [
  path.resolve(__dirname, '../../.env'), // monorepo gyökér
  path.resolve(__dirname, '../.env'),    // backend/.env
  path.resolve(process.cwd(), '.env'),   // futtatási CWD
];
for (const p of candidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    console.log(`[ENV] Loaded: ${p}`);
    break;
  }
}

// --- Firestore helper: folyamat beolvasása id alapján ---
async function getProcessConfigById(processId) {
  const snap = await db.collection('processes').doc(String(processId)).get();
  if (!snap.exists) return null;
  return { processId: snap.id, ...snap.data() };
}

const router = express.Router();

// JSON body parsing
router.use(express.json());

/**
 * UNAS ProductDB mezőlista lekérése adott shophoz
 */
const { fetchUnasFieldsFromFirestore } = require('./unasFields');
router.get('/unas/fields', async (req, res) => {
  try {
    const { shopId } = req.query || {};
    if (!shopId) return res.status(400).json({ error: 'shopId szükséges' });

    const payload = await fetchUnasFieldsFromFirestore(shopId);
    return res.json(payload);
  } catch (e) {
    console.error('[UNAS] /unas/fields error:', e?.message || e);
    if (process.env.UNAS_FIELDS_FAKE === '1') {
      return res.json({
        shopId: req.query?.shopId,
        count: 6,
        fields: ['Cikkszám','Nettó Ár','Bruttó Ár','Raktárkészlet','Leírás','Kategória'].map(x => ({key:x,label:x}))
      });
    }
    return res.status(500).json({
      error: 'UNAS fields fetch failed',
      detail: String(e?.message || e),
      shopId: req.query?.shopId
    });
  }
});

/**
 * Firestore-os konfig olvasás
 */
router.get('/config', async (_req, res) => {
  try {
    const shopsSnap = await db.collection('shops').get();
    const shops = shopsSnap.docs.map((d) => ({ shopId: d.id, ...d.data() }));

    const procsSnap = await db.collection('processes').get();
    const processes = procsSnap.docs.map((d) => ({ processId: d.id, ...d.data() }));

    res.json({ shops, processes });
  } catch (e) {
    console.error('/config GET error:', e);
    res.status(500).json({ error: e.message, shops: [], processes: [] });
  }
});

/**
 * Firestore-os konfig mentés (processes)
 */
router.post('/config', async (req, res) => {
  try {
    const { processes: newProcesses } = req.body || {};
    if (!Array.isArray(newProcesses)) {
      return res.status(400).json({ error: 'processes tömb szükséges' });
    }

    const batch = db.batch();
    const seen = new Set();

    newProcesses.forEach((p) => {
      const id = String(p.processId || '');
      if (!id) return;
      seen.add(id);
      const ref = db.collection('processes').doc(id);
      const { processId, ...data } = p;
      batch.set(ref, data, { merge: true });
    });

    const existing = await db.collection('processes').get();
    existing.forEach((doc) => {
      if (!seen.has(doc.id)) {
        batch.delete(db.collection('processes').doc(doc.id));
      }
    });

    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    console.error('/config POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Egy folyamat futtatása most
 */
router.post('/run', async (req, res) => {
  try {
    const { processId } = req.body || {};
    if (!processId) {
      return res.status(400).json({ success: false, error: 'processId required' });
    }

    const processConfig = await getProcessConfigById(processId);
    if (!processConfig) {
      return res.status(404).json({ success: false, error: `Process not found: ${processId}` });
    }

    const t0 = Date.now();
    const dl = await downloadFile(processConfig.feedUrl);
    const rawSize = dl?.length || 0;

    const parsed = await parseData(dl, processConfig);
    const parsedCount = Array.isArray(parsed) ? parsed.length : 0;

    const transformed = await transformData(parsed, processConfig);
    const transformedCount = Array.isArray(transformed) ? transformed.length : 0;

    const withSku = (transformed || []).filter(
      (x) => x?.sku || x?.Sku || x?.SKU
    );
    const uploadCandidates = withSku.length;

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
      },
      sample: {
        parsed: parsed?.[0] || null,
        transformed: transformed?.[0] || null,
      },
    });
  } catch (e) {
    console.error('❌ /run hiba:', e);
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/**
 * Folyamat törlése
 */
router.delete('/config/:processId', async (req, res) => {
  try {
    const { processId } = req.params;
    if (!processId)
      return res.status(400).json({ ok: false, error: 'processId required' });

    const ref = db.collection('processes').doc(String(processId));
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ ok: false, error: 'Process not found', processId });

    const removed = { processId: snap.id, ...snap.data() };
    await ref.delete();

    return res.json({ ok: true, removed });
  } catch (e) {
    console.error('[DELETE /api/config/:processId] error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * Logok
 */
router.get('/logs', (_req, res) => {
  res.json(getLogs());
});

/**
 * Árfolyamok
 */
router.get('/rates', (_req, res) => {
  const { rates, lastUpdated } = rateUpdater.getRates();
  res.json({ rates, lastUpdated });
});

/**
 * Fejlesztői / teszt végpontok
 */
const testUnas = require('./testUnas');
router.use('/test/unas', testUnas);

module.exports = router;
