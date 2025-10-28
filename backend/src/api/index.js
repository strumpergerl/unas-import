// backend/src/api/index.js
require('../bootstrapEnv');
const express = require('express');
// const path = require('path');
const { db } = require('../db/firestore');
const { BadRequestError, AppError } = require('../shared/errors');
const { fetchProductDbHeaders } = require('../services/unas');
const { loadShopById } = require('../services/shops');
const downloadFile = require('../core/downloadFile');
const parseData = require('../core/parseData');
const transformData = require('../core/transformData');
const rateUpdater = require('../utils/rateUpdater');
const { getLogs, addRun } = require('../runner');
const {
	requireFirebaseUser,
	allowCronOrUser,
} = require('../../middlewares/auth');
const inngestHandler = require('../inngest');

let uploadToUnas = null;

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

function parseFrequencyMs(freq) {
	if (typeof freq !== 'string') return null;
	const trimmed = freq.trim().toLowerCase();
	if (!trimmed || trimmed === '0') return null;
	const match = trimmed.match(/^([0-9]+)\s*([smhd])$/);
	if (!match) return null;
	const value = parseInt(match[1], 10);
	const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
	if (!Number.isFinite(value) || value <= 0 || !unit) return null;
	return value * unit;
}

function toDate(value) {
	if (!value) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'string') {
		const parsed = new Date(value);
		return Number.isFinite(parsed.getTime()) ? parsed : null;
	}
	if (typeof value.toDate === 'function') {
		const parsed = value.toDate();
		return parsed instanceof Date ? parsed : null;
	}
	return null;
}

function computeNextRunIso(anchorDate, intervalMs, now = new Date()) {
	if (!anchorDate || !intervalMs) return null;
	const anchorMs = anchorDate.getTime();
	if (!Number.isFinite(anchorMs)) return null;
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) return null;
	const firstRunMs = anchorMs + intervalMs;
	if (nowMs <= firstRunMs) {
		return new Date(firstRunMs).toISOString();
	}
	const diff = nowMs - anchorMs;
	const steps = Math.floor(diff / intervalMs) + 1;
	return new Date(anchorMs + steps * intervalMs).toISOString();
}

router.use('/inngest', express.raw({ type: '*/*' }), (req, res, next) => {
	// Inngest-nek továbbadjuk
	return inngestHandler(req, res, next);
});

// --- Egyszerű per-IP rate limiter a /rates endpointhoz ---
// Beállítások: 60 kérés / 1 perc/IP (env-ből felülírható)
const RATES_LIMIT = Number(process.env.RATES_LIMIT || 60);
const RATES_WINDOW_MS = Number(process.env.RATES_WINDOW_MS || 60_000);
const ratesBuckets = new Map(); // ip -> { count, resetAt }

function getClientIp(req) {
	// Proxy mögött: X-Forwarded-For első elemét használjuk
	const xff = (req.headers['x-forwarded-for'] || '')
		.toString()
		.split(',')[0]
		.trim();
	return xff || req.ip || req.connection?.remoteAddress || 'unknown';
}

function ratesRateLimit(req, res, next) {
	const ip = getClientIp(req);
	const now = Date.now();
	const b = ratesBuckets.get(ip) || {
		count: 0,
		resetAt: now + RATES_WINDOW_MS,
	};
	if (now > b.resetAt) {
		b.count = 0;
		b.resetAt = now + RATES_WINDOW_MS;
	}
	b.count += 1;
	ratesBuckets.set(ip, b);

	const remaining = Math.max(0, RATES_LIMIT - b.count);
	res.set({
		'X-RateLimit-Limit': String(RATES_LIMIT),
		'X-RateLimit-Remaining': String(remaining),
		'X-RateLimit-Reset': String(Math.ceil(b.resetAt / 1000)), // epoch sec
	});

	if (b.count > RATES_LIMIT) {
		return res.status(429).json({ error: 'Rate limit exceeded' });
	}
	return next();
}

// Healthcheck
router.get('/health', (_req, res) => {
	safeJson(res, 200, { ok: true, time: new Date().toISOString() });
});

// Auth middlewarek
// Csak a routeren belüli route-okra vonatkozzon az auth middleware
router.use((req, res, next) => {
	if (req.path.startsWith('/inngest')) return next();
	if (req.path.startsWith('/rates')) return next();
	return allowCronOrUser(requireFirebaseUser)(req, res, next);
});

// --- /unas/fields cache ---
// const unasFieldsCache = new Map(); // kulcs: shopId|processId, érték: { ts, data }

async function fetchAndStoreUnasFields(shopId, processId) {
  const shop = await loadShopById(shopId);
  const { apiKey } = shop;

  let paramsXml = null;
  if (processId) {
    const doc = await db.collection('processes').doc(String(processId)).get();
    if (doc.exists) {
      const pc = doc.data() || {};
      paramsXml = pc?.productDb?.paramsXml || pc?.unas?.productDb?.paramsXml || null;
    }
  }

  const { headers } = await fetchProductDbHeaders({ apiKey, paramsXml });
  const fields = headers.map(h => ({
    key: String(h.key || h),
    label: String(h.label || h),
    id: h.id !== undefined ? String(h.id) : null,
  }));

  const payload = {
    shopId,
    fields,
    count: fields.length,
    updatedAt: new Date().toISOString(),
  };
  await db.collection('unasFields').doc(String(shopId)).set(payload, { merge: true });
  return payload;
}

// --- UNAS mezők (Firestore cache + opciós refresh) ---
const UNAS_FIELDS_TTL_MS = Number(process.env.UNAS_FIELDS_TTL_MS || 24 * 60 * 60 * 1000); // 24h

router.get('/unas/fields', async (req, res) => {
  try {
    const { shopId, processId, refresh } = req.query || {};
    if (!shopId) throw new BadRequestError('shopId szükséges');

    const ref = db.collection('unasFields').doc(String(shopId));
    const snap = await ref.get();
    const now = Date.now();

    // ha kényszerített frissítés kérve, vagy nincs cache, vagy lejárt → lehúzzuk UNAS-ból
    let shouldRefresh = String(refresh || '') === '1';
    let cached = snap.exists ? (snap.data() || null) : null;

    if (!shouldRefresh && cached?.updatedAt) {
      const ageMs = now - new Date(cached.updatedAt).getTime();
      if (ageMs > UNAS_FIELDS_TTL_MS) shouldRefresh = true;
    }
    if (!cached) shouldRefresh = true;

    if (shouldRefresh) {
      const fresh = await fetchAndStoreUnasFields(shopId, processId);
      return res.json({ ...fresh, source: 'unas' });
    }
    // van érvényes cache
    return res.json({ ...cached, source: 'cache' });
  } catch (e) {
    console.error('[GET /api/unas/fields] error:', e);
    const status = e?.code === 'BAD_REQUEST' ? 400 : 500;
    return res.status(status).json({ error: e.message || 'Hiba', code: e.code || 'ERR' });
  }
});

// --- /api/config cache ---
let configCache = null;
let configCacheTs = 0;
const CONFIG_CACHE_TTL_MS = 30 * 1000; // 30 másodperc

router.get('/config', async (_req, res) => {
	try {
		const now = Date.now();
		if (configCache && now - configCacheTs < CONFIG_CACHE_TTL_MS) {
			return safeJson(res, 200, configCache);
		}
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

		const payload = { shops, processes };
		configCache = payload;
		configCacheTs = now;
		return safeJson(res, 200, payload);
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
		let buf;
		try {
			buf = await downloadFile(url);
		} catch (err) {
			console.error(
				'[API] /api/feed/headers letöltési hiba:',
				err?.message || err
			);
			return res.status(502).json({
				error: 'Feed letöltése sikertelen',
				details: err?.message || err,
			});
		}

		// 2) parse – univerzális parserrel
		let rows;
		try {
			rows = await parseData(buf, { feedUrl: url });
		} catch (err) {
			console.error('[API] /api/feed/headers parse hiba:', err?.message || err);
			return res.status(422).json({
				error: 'Feed feldolgozása sikertelen',
				details: err?.message || err,
			});
		}

		// 3) fejlécek = első sor kulcsai
		const header =
			Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [];

		// 4) normalizált válasz a frontendnek
		const fields = (header || [])
			.map((h) => ({ key: h, label: String(h).trim() }))
			.filter((f) => f.label);
		res.json({ count: fields.length, fields });
		console.log('[API] /api/feed/headers', {
			url,
			count: fields.length,
			sample: fields.slice(0, 3),
		});
	} catch (e) {
		console.error('[GET /api/feed/headers] error:', e);
		res.status(500).json({ error: e.message || 'Ismeretlen hiba', details: e });
	}
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
			failed: 0,
			skippedNoChange: 0,
			skippedNoKey: 0,
			skippedNotFound: 0,
			skippedNotFoundCount: 0,
		},
		items: [],
		error: null,
	};

	try {
		const {
			processId,
			feedUrl,
			fieldMapping = [],
			pricingFormula = '',
			rounding = 1,
			vat = 27,
			discount = 0,
			priceMargin = 0,
			dryRun = true,
			shopId,
			records,
			keyFields,
			priceFields,
			stockFields,
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
				keyFields,
				priceFields,
				stockFields,
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
		let transformed = await transformData(inputRows, cfg);
		const t5 = Date.now();
		run.stages.transformMs = t5 - t4;
		run.counts.output = transformed.length;

		if (cfg?.keyFields?.feed) {
			const feedKey = String(cfg.keyFields.feed);
			transformed = transformed.map((row, i) => {
				const src = inputRows[i] || {};
				return (src[feedKey] === undefined) ? row : { ...row, [feedKey]: src[feedKey] };
			});
		}

		// Feltöltés
		const t6 = Date.now();
		let uploadResult = null;
		if (!cfg.dryRun) {
			if (!uploadToUnas) uploadToUnas = require('../core/uploadToUnas');
			uploadResult = await uploadToUnas(transformed, cfg, shop);
		}
		const t7 = Date.now();
		run.stages.uploadMs = t7 - t6;

		// Számlálók + tételek (ha az uploadToUnas részletes statot ad vissza)
		if (uploadResult) {
			run.counts.modified         = Array.isArray(uploadResult?.modified) ? uploadResult.modified.length : 0;
			run.counts.failed           = Array.isArray(uploadResult?.failed) ? uploadResult.failed.length : 0;
			run.counts.skippedNoChange  = uploadResult?.skippedNoChangeCount || 0;
			run.counts.skippedNoKey     = uploadResult?.skippedNoKeyCount || 0;
			run.counts.skippedNotFound  = uploadResult?.skippedNotFoundCount || 0;
			run.counts.feedSupplier     = uploadResult?.feedSupplierCount ?? run.counts.input ?? 0;
			run.counts.unasSupplier     = uploadResult?.unasSupplierCount ?? 0;

			// csak módosított és hibás tételek kerüljenek a log tételek közé
			for (const m of uploadResult?.modified || []) {
				const hasChange = m.changes && Object.keys(m.changes).length > 0;
				run.items.push({
					sku: m.sku ?? null,
					action: hasChange ? 'modify' : 'skip',
					changes: m.changes || {},
					before: m.before ?? null,
					after: m.after ?? null,
				});
			}
			// (opcionális) ha nem akarod listázni a "no key" tételeket, a lenti blokkot törölheted
			for (const s of uploadResult?.skippedNoKey || []) {
				run.items.push({
					sku: s.sku ?? null,
					action: 'skip',
					error: 'No key',
				});
			}
			for (const s of uploadResult?.skippedNotFound || []) {
				run.items.push({
					sku: s.sku ?? null,
					action: 'skip',
					error: 'Not found',
				});
			}
			for (const f of uploadResult?.failed || []) {
				run.items.push({
					sku: f.sku ?? null,
					action: 'fail',
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

// POST /api/config –  process létrehozása/frissítése
// A futtatási ütemezés a létrehozáskori horgonyhoz igazodik, szerkesztéskor nem állítjuk vissza
router.post('/config', async (req, res) => {
	try {
		const p = req.body || {};

		// azonosító: id vagy processId; ha nincs, új doksi jön létre
		const docId = (p.id || p.processId || '').toString().trim();
		const col = db.collection('processes');
		const ref = docId ? col.doc(docId) : col.doc();

		// minimál ellenőrzés
		// if (!p.frequency || !/^\d+\s*[smhd]$/i.test(String(p.frequency))) {
		// 	return res.status(400).json({
		// 		error: 'Érvénytelen vagy hiányzó frequency (pl. "30m", "3h", "1d")',
		// 	});
		// }

		const now = new Date();
		const nowIso = now.toISOString();

		// ne írjuk vissza az azonosító/automatikus mezőket
		const {
			id,
			processId,
			referenceAt,
			nextRunAt,
			createdAt,
			updatedAt,
			...data
		} = p;

		const snap = await ref.get();
		const isNew = !snap.exists;
		const existingData = snap.exists ? snap.data() || {} : {};

		const createdAtDate = isNew
			? now
			: toDate(existingData.createdAt) || now;
		const createdAtIso = createdAtDate.toISOString();

		const referenceDate =
			toDate(existingData.referenceAt) ||
			createdAtDate;
		const referenceAtIso = referenceDate.toISOString();

		const intervalMs = parseFrequencyMs(data.frequency);
		const calcNextRunAt = intervalMs
			? computeNextRunIso(referenceDate, intervalMs, now)
			: null;

		await ref.set(
			{
				...data,
				referenceAt: referenceAtIso,
				nextRunAt: calcNextRunAt,
				updatedAt: nowIso,
				...(isNew ? { createdAt: createdAtIso } : {}),
			},
			{ merge: true }
		);

		const saved = await ref.get();
		// Mindig legyen processId mező a válaszban (és a doksiban is)
		const savedData = saved.data() || {};
		if (!savedData.processId) {
			await ref.set({ processId: ref.id }, { merge: true });
			savedData.processId = ref.id;
		}
		res.json({ id: ref.id, processId: ref.id, ...savedData });
	} catch (err) {
		console.error('/config POST error:', err);
		res.status(500).json({ error: err.message || 'Hiba' });
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
router.get('/rates', ratesRateLimit, (_req, res) => {
	try {
		res.set({
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			Vary: 'Origin',
			'Cache-Control':
				'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
			'CDN-Cache-Control': 'public, max-age=300',
		});
		const getter = rateUpdater?.getRates || rateUpdater;
		if (typeof getter !== 'function') {
			console.error(
				'[DEBUG] rateUpdater is not initialized or getRates is not a function'
			);
			return safeJson(res, 503, {
				rates: {},
				lastUpdated: null,
				error: 'Árfolyam szolgáltatás nincs inicializálva.',
			});
		}
		const out = getter() || {};
		console.log('[DEBUG] rateUpdater.getRates output:', out);
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

router.options('/rates', (_req, res) => {
	res.set({
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
	});
	res.status(204).end();
});

module.exports = router;
