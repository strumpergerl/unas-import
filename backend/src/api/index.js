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
const transformData = require('../core/transformData');
const uploadToUnas = require('../core/uploadToUnas');
const rateUpdater = require('../utils/rateUpdater');
const { getLogs } = require('../runner');

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


// --- FUTTATÁS INDÍTÁSA ---
router.post('/run', async (req, res) => {
  try {
    // 1) payload
    const {
      processId,
      // opcionális: közvetlen futtatáshoz body-ban kapott konfig
      feedUrl,
      fieldMapping = {},
      pricingFormula = '',
      rounding = 1,
      vat = 27,
      discount = 0,
      priceMargin = 0,
      dryRun = true,
      shopId,
      // ha a frontend előre elkészített rekordokat küldene:
      records,
    } = req.body || {};

    // 2) process betöltés Firestore-ból, ha csak processId jött
    let procCfg = null;
    if (processId && !feedUrl && !records) {
      const doc = await db.collection('processes').doc(processId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: `Process nem található: ${processId}` });
      }
      procCfg = { processId: doc.id, ...doc.data() };
    }

    // 3) végső konfig (Firestore-ból vagy a body-ból)
    const cfg = procCfg ?? {
      processId: processId || null,
      feedUrl,
      fieldMapping,
      pricingFormula,
      rounding,
      vat,
      discount,
      priceMargin,
      dryRun,
      shopId,
    };

    if (!cfg.feedUrl && !Array.isArray(records)) {
      return res.status(400).json({ error: 'Hiányzik a feedUrl (vagy a records)!' });
    }

    // 4) shop betöltése (ha kell az UNAS auth-hoz)
    const shop = cfg.shopId ? await loadShopById(cfg.shopId) : null;

    // 5) bemenet (records vagy letöltés + parse)
    let inputRows = Array.isArray(records) ? records : [];
    if (!inputRows.length) {
      const buf = await downloadFile(cfg.feedUrl);
      // egységes: a parseData második paramétere legyen objektum
      // (ha a te parseData-ed sima stringet vár, itt cseréld { feedUrl: cfg.feedUrl } -> cfg.feedUrl)
      inputRows = await parseData(buf, { feedUrl: cfg.feedUrl });
    }
    const inputCount = inputRows.length;

    // 6) transzformáció (mező-mapping, árképzés, stb.)
    const transformed = await transformData(inputRows, cfg);
    const outputCount = transformed.length;

    // 7) feltöltés UNAS-ba csak ha NEM dryRun
    let uploadResult = null;
    if (!cfg.dryRun) {
      // a te modulod szignatúrája szerint hagyom a 3 paramétert
      uploadResult = await uploadToUnas(transformed, cfg, shop);
    }

    // 8) válasz
    return res.json({
      ok: true,
      processId: cfg.processId || null,
      counts: { input: inputCount, output: outputCount },
      sampleIn: inputRows.slice(0, 3),
      sampleOut: transformed.slice(0, 3),
      upload: uploadResult,
    });
  } catch (e) {
    console.error('[POST /api/run] error:', e);
    return res.status(500).json({ error: e.message || 'Ismeretlen hiba' });
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

// --- NAPLÓK LISTÁZÁSA ---
router.get('/logs', (_req, res) => res.json(getLogs()));

// --- DEVIZAÁRFOLYAMOK LISTÁZÁSA ---
router.get('/rates', (_req, res) => {
  const { rates, lastUpdated } = rateUpdater.getRates();
  res.json({ rates, lastUpdated });
});


module.exports = router;
