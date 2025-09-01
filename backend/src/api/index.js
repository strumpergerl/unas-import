// backend/src/api/index.js
require('../bootstrapEnv');
const express = require('express');
const path = require('path');
const { db } = require('../db/firestore');
const { BadRequestError, AppError } = require('../shared/errors');
const { fetchProductDbHeaders } = require('../services/unas');
const { loadShopById } = require('../services/shops');
const downloadFile = require('../core/downloadFile');
const parseData = require('../core/parseData');

// opcionális: egyéb core funkciók, ha használod
// const transformData = require('../core/transformData');
// const uploadToUnas = require('../core/uploadToUnas');
// const rateUpdater = require('../utils/rateUpdater');
// const { getLogs } = require('../runner');

const router = express.Router();
router.use(express.json());

/** UNAS ProductDB mezőlista adott shopDocId szerint */
router.get('/unas/fields', async (req, res) => {
  try {
    const { shopId } = req.query || {};
    if (!shopId) throw new BadRequestError('shopId szükséges');

    const shop = await loadShopById(shopId);
    const { apiKey } = shop;

    // FIGYELEM: az egyszerűsített UNAS kliensünk már csak apiKey-t kér
    const { headers } = await fetchProductDbHeaders({ apiKey });
    const fields = headers.map(h => ({ key: String(h), label: String(h) }));

    return res.json({ shopId, count: fields.length, fields });
  } catch (e) {
    console.error('[GET /api/unas/fields] error:', e);
    const status = e?.code === 'BAD_REQUEST' ? 400 : 500;
    // Mindig JSON-t adunk vissza
    return res.status(status).json({ error: e.message || 'Hiba', code: e.code || 'ERR' });
  }
});

/** Firestore konfig olvasás */
router.get('/config', async (_req, res) => {
  try {
    const shopsSnap = await db.collection('shops').get();
    const shops = shopsSnap.docs.map((d) => ({ shopId: d.id, ...d.data() }));
    const procsSnap = await db.collection('processes').get();
    const processes = procsSnap.docs.map((d) => ({ processId: d.id, ...d.data() }));
    res.json({ shops, processes });
  } catch (e) {
    console.error('[GET /api/config] error:', e);
    res.status(500).json({ error: e.message, shops: [], processes: [] });
  }
});

/** Firestore konfig mentés (processes) */
router.post('/config', async (req, res) => {
  try {
    const { processes: newProcesses } = req.body || {};
    if (!Array.isArray(newProcesses)) throw new BadRequestError('processes tömb szükséges');

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
      if (!seen.has(doc.id)) batch.delete(db.collection('processes').doc(doc.id));
    });

    await batch.commit();
    res.json({ success: true });
  } catch (e) {
    console.error('[POST /api/config] error:', e);
    const status = e?.code === 'BAD_REQUEST' ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// GET /api/feed/headers?url=...
router.get('/feed/headers', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Hiányzik: url' });

    // 1) letöltés a meglévő downloaderrel
    const buf = await downloadFile(url); // :contentReference[oaicite:2]{index=2}

    // 2) parse – a meglévő univerzális parserrel
    const rows = await parseData(buf, { feedUrl: url }); // :contentReference[oaicite:3]{index=3}

    // 3) fejlécek = első sor kulcsai
    const header = Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [];

    // 4) normalizált válasz a frontendnek
    const fields = header.map(h => ({ key: h, label: String(h).trim() })).filter(f => f.label);
    res.json({ count: fields.length, fields });
  } catch (e) {
    console.error('[GET /api/feed/headers] error:', e);
    res.status(500).json({ error: e.message || 'Ismeretlen hiba' });
  }
});

/** Példa: logok, rate-ek – csak ha tényleg használod
router.get('/logs', (_req, res) => res.json(getLogs()));
router.get('/rates', (_req, res) => {
  const { rates, lastUpdated } = rateUpdater.getRates();
  res.json({ rates, lastUpdated });
});
*/

module.exports = router;
