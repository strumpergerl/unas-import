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
const transformData = require('../core/transformData');
const uploadToUnas = require('../core/uploadToUnas');
const rateUpdater = require('../utils/rateUpdater');
const { getLogs, addRun } = require('../runner');

const router = express.Router();
router.use(express.json());

// Kis helper a biztonságos JSON válaszhoz
function safeJson(res, status, payload) {
	try {
		return res.status(status).json(payload);
	} catch {
		res
			.status(500)
			.set('Content-Type', 'application/json; charset=utf-8')
			.end('{"error":"Internal error"}');
	}
}

/** UNAS ProductDB mezőlista adott shopDocId szerint */
router.get('/unas/fields', async (req, res) => {
	try {
		const { shopId } = req.query || {};
		if (!shopId) throw new BadRequestError('shopId szükséges');

		const shop = await loadShopById(shopId);
		const { apiKey } = shop;

		// FIGYELEM: az egyszerűsített UNAS kliensünk már csak apiKey-t kér
		const { headers } = await fetchProductDbHeaders({ apiKey });
		const fields = headers.map((h) => ({ key: String(h), label: String(h) }));

		return res.json({ shopId, count: fields.length, fields });
	} catch (e) {
		console.error('[GET /api/unas/fields] error:', e);
		const status = e?.code === 'BAD_REQUEST' ? 400 : 500;
		// Mindig JSON-t adunk vissza
		return res
			.status(status)
			.json({ error: e.message || 'Hiba', code: e.code || 'ERR' });
	}
});

/** Firestore konfig olvasás */
router.get('/config', async (_req, res) => {
	try {
		if (!db || !db.collection) {
			return safeJson(res, 503, {
				shops: [],
				processes: [],
				error: 'Firestore nincs inicializálva.',
			});
		}

		const shopsSnap = await db.collection('shops').get();
		const shops = shopsSnap.docs.map((d) => ({ shopId: d.id, ...d.data() }));

		const procsSnap = await db.collection('processes').get();
		const processes = procsSnap.docs.map((d) => ({
			processId: d.id,
			...d.data(),
		}));

		return safeJson(res, 200, { shops, processes });
	} catch (e) {
		console.error('[GET /api/config] error:', e);
		return safeJson(res, 500, {
			shops: [],
			processes: [],
			error: e?.message || 'Hiba',
		});
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
		const header =
			Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [];

		// 4) normalizált válasz a frontendnek
		const fields = header
			.map((h) => ({ key: h, label: String(h).trim() }))
			.filter((f) => f.label);
		res.json({ count: fields.length, fields });
	} catch (e) {
		console.error('[GET /api/feed/headers] error:', e);
		res.status(500).json({ error: e.message || 'Ismeretlen hiba' });
	}
});

// Healthcheck (hasznos debughoz)
router.get('/health', (_req, res) => {
	safeJson(res, 200, { ok: true, time: new Date().toISOString() });
});

// --- FUTTATÁS INDÍTÁSA ---
router.post('/run', async (req, res) => {
	const startedAt = new Date();
	const run = {
		id: `manual_${startedAt.toISOString()}`,
		processId: null,
		processName: null,
		shopId: null,
		shopName: null,
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		durationMs: null,
		stages: { downloadMs: 0, parseMs: 0, transformMs: 0, uploadMs: 0 },
		counts: {
			input: 0,
			output: 0,
			modified: 0,
			skippedNoKey: 0,
			skippedNotFound: 0,
			failed: 0,
		},
		items: [],
		error: null,
	};

	try {
		const {
			processId,
			feedUrl,
			fieldMapping = {},
			pricingFormula = '',
			rounding = 1,
			vat = 27,
			discount = 0,
			priceMargin = 0,
			dryRun = true,
			shopId,
			records,
		} = req.body || {};

		// Process betöltés Firestore-ból, ha csak processId jött
		let cfg = null;
		if (processId && !feedUrl && !records) {
			const doc = await db.collection('processes').doc(String(processId)).get();
			if (!doc.exists)
				return res
					.status(404)
					.json({ error: `Process nem található: ${processId}` });
			cfg = { processId: doc.id, ...doc.data() };
		} else {
			cfg = {
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
		}

		run.processId = cfg.processId;
		run.processName = cfg.displayName || cfg.processId || 'Ad hoc futás';

		if (!cfg.feedUrl && !Array.isArray(records)) {
			return res
				.status(400)
				.json({ error: 'Hiányzik a feedUrl (vagy a records)!' });
		}

		// Shop névhez / UNAS auth-hoz
		const shop = cfg.shopId ? await loadShopById(cfg.shopId) : null;
		if (shop) {
			run.shopId = shop.shopId;
			run.shopName = shop.name;
		}

		// Letöltés + parse
		const t1 = Date.now();
		let inputRows = Array.isArray(records) ? records : [];
		if (!inputRows.length) {
			const buf = await downloadFile(cfg.feedUrl);
			const t2 = Date.now();
			inputRows = await parseData(buf, { feedUrl: cfg.feedUrl });
			const t3 = Date.now();
			run.stages.downloadMs = t2 - t1;
			run.stages.parseMs = t3 - t2;
		}
		run.counts.input = inputRows.length;

		// Transzformáció
		const t4 = Date.now();
		const transformed = await transformData(inputRows, cfg);
		const t5 = Date.now();
		run.stages.transformMs = t5 - t4;
		run.counts.output = transformed.length;

		// Feltöltés
		const t6 = Date.now();
		let uploadResult = null;
		if (!cfg.dryRun) uploadResult = await uploadToUnas(transformed, cfg, shop);
		const t7 = Date.now();
		run.stages.uploadMs = t7 - t6;

		// Számlálók + tételek (ha az uploadToUnas részletes statot ad vissza)
		if (uploadResult) {
			run.counts.modified = uploadResult?.modified?.length || 0;
			run.counts.skippedNoKey = uploadResult?.skippedNoKey?.length || 0;
			run.counts.skippedNotFound = uploadResult?.skippedNotFound?.length || 0;
			run.counts.failed = uploadResult?.failed?.length || 0;

			for (const m of uploadResult?.modified || []) {
				run.items.push({
					key: m.key ?? null,
					sku: m.sku ?? null,
					action: 'modify',
					changes: m.changes || {},
					before: m.before ?? null,
					after: m.after ?? null,
				});
			}
			for (const s of uploadResult?.skippedNoKey || []) {
				run.items.push({
					key: s.key ?? null,
					sku: null,
					action: 'skip',
					changes: {},
					before: null,
					after: null,
					error: s.reason || 'No key',
				});
			}
			for (const s of uploadResult?.skippedNotFound || []) {
				run.items.push({
					key: s.key ?? null,
					sku: null,
					action: 'skip',
					changes: {},
					before: null,
					after: null,
					error: s.reason || 'Not found',
				});
			}
			for (const f of uploadResult?.failed || []) {
				run.items.push({
					key: f.key ?? null,
					sku: f.sku ?? null,
					action: 'fail',
					changes: {},
					before: null,
					after: null,
					error: f.error || f.statusText || 'Failed',
				});
			}
		}

		res.json({
			ok: true,
			processId: cfg.processId || null,
			counts: { input: run.counts.input, output: run.counts.output },
			sampleIn: inputRows.slice(0, 3),
			sampleOut: transformed.slice(0, 3),
			upload: uploadResult,
		});
	} catch (e) {
		run.error = e?.message || 'Ismeretlen hiba';
		console.error('[POST /api/run] error:', e);
		res.status(500).json({ error: run.error });
	} finally {
		const finished = new Date();
		run.finishedAt = finished.toISOString();
		run.durationMs = finished - new Date(run.startedAt);

		try {
			await addRun(run);
			console.log('[API/RUN] Log mentve:', run.id);
		} catch (e) {
			console.error('[API/RUN] addRun HIBA:', e?.message || e);
		}
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
			return res
				.status(404)
				.json({ ok: false, error: 'Process not found', processId });

		const removed = { processId: snap.id, ...snap.data() };
		await ref.delete();

		return res.json({ ok: true, removed });
	} catch (e) {
		console.error('[DELETE /api/config/:processId] error:', e);
		return res.status(500).json({ ok: false, error: 'Internal error' });
	}
});

// --- NAPLÓK LISTÁZÁSA ---
router.get('/logs', async (_req, res) => {
	try {
		const list = await getLogs(100);
		return safeJson(res, 200, Array.isArray(list) ? list : []);
	} catch (e) {
		console.error('[GET /api/logs] error:', e);
		return safeJson(res, 500, { error: e?.message || 'Hiba' });
	}
});

// --- NAPLÓK PRUNE (opcionális kézi hívás) ---
router.post('/logs/prune', async (req, res) => {
	const days = Number(req.body?.days ?? 30);
	try {
		const { pruneOldRuns } = require('../runner');
		const deleted = await pruneOldRuns(days);
		return res.status(200).json({ ok: true, deleted, days });
	} catch (e) {
		console.error('[POST /api/logs/prune] error:', e);
		return res.status(500).json({ error: e?.message || 'Hiba' });
	}
});

// --- DEVIZAÁRFOLYAMOK LISTÁZÁSA ---
router.get('/rates', (_req, res) => {
	try {
		const getter = rateUpdater?.getRates || rateUpdater;
		if (typeof getter !== 'function') {
			return safeJson(res, 503, {
				rates: {},
				lastUpdated: null,
				error: 'Árfolyam szolgáltatás nincs inicializálva.',
			});
		}
		const out = getter() || {};
		const rates = out.rates || {};
		const lastUpdated = out.lastUpdated || null;
		return safeJson(res, 200, { rates, lastUpdated });
	} catch (e) {
		console.error('[GET /api/rates] error:', e);
		return safeJson(res, 500, {
			rates: {},
			lastUpdated: null,
			error: e?.message || 'Hiba',
		});
	}
});

module.exports = router;
