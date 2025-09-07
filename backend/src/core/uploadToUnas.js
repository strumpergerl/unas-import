// backend/src/core/uploadToUnas.js
require('../bootstrapEnv');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { getBearerToken } = require('../services/unas');
const { loadShopById } = require('../services/shops');
const { parse: csvParse } = require('csv-parse/sync');
const { db } = require('../db/firestore');

// --- Beállítások ENV-ből (biztonságos defaultokkal)
const BASE_URL = process.env.UNAS_API_URL || 'https://api.unas.eu/shop';
const UNAS_TIMEOUT_MS = Number(process.env.UNAS_TIMEOUT_MS) || 30000;
const UNAS_DOWNLOAD_TIMEOUT_MS =
	Number(process.env.UNAS_DOWNLOAD_TIMEOUT_MS) || 60000;
const UNAS_PRODUCTDB_MAX_RETRIES =
	Number(process.env.UNAS_PRODUCTDB_MAX_RETRIES) || 3;
const UNAS_PRODUCTDB_BACKOFF_MS =
	Number(process.env.UNAS_PRODUCTDB_BACKOFF_MS) || 2000;
const UNAS_INDEX_TTL_HOURS = Number(process.env.UNAS_INDEX_TTL_HOURS) || 12;

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'unas-cache');
function ensureCacheDir() {
	try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
}
ensureCacheDir();

const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 20 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ---- Közös utilok ----
const toPosNumberString = (v) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return '0';
	return Math.max(0, n).toString();
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const hash = (obj) =>
	crypto
		.createHash('md5')
		.update(JSON.stringify(obj))
		.digest('hex')
		.slice(0, 8);

const formulaHasVat = (formula) =>
	typeof formula === 'string' && /\{vat\}/i.test(formula);

// ---- Mezők kiválasztása a feed rekordból  ----
function pickFeedKeyValueDynamic(rec, feedKey) {
	console.log('[DEBUG] pickFeedKeyValueDynamic', { rec, feedKey });
	return rec?.[feedKey];
}

/** Nettó/Bruttó biztosítása a processConfig alapján */
function ensureNetGross(item, processConfig) {
	const vatPct = Number(processConfig?.vat ?? 0);
	const vatFactor = 1 + (isFinite(vatPct) ? vatPct : 0) / 100;

	const inNet = item.price_net != null ? Number(item.price_net) : null;
	const inGross = item.price_gross != null ? Number(item.price_gross) : null;
	const legacy = item.price != null ? Number(item.price) : null;

	const treatLegacyAsGross = formulaHasVat(processConfig?.pricingFormula);

	let net = null,
		gross = null;
	if (
		Number.isFinite(inNet) &&
		inNet > 0 &&
		Number.isFinite(inGross) &&
		inGross > 0
	) {
		net = inNet;
		gross = inGross;
	} else if (Number.isFinite(inNet) && inNet > 0) {
		net = inNet;
		gross = inNet * vatFactor;
	} else if (Number.isFinite(inGross) && inGross > 0) {
		gross = inGross;
		net = vatFactor > 0 ? inGross / vatFactor : inGross;
	} else if (Number.isFinite(legacy) && legacy > 0) {
		if (treatLegacyAsGross) {
			gross = legacy;
			net = vatFactor > 0 ? legacy / vatFactor : legacy;
		} else {
			net = legacy;
			gross = legacy * vatFactor;
		}
	} else {
		net = 0;
		gross = 0;
	}

	net = Math.floor(Math.max(0, net));
	gross = Math.floor(Math.max(0, gross));
	return {
		net,
		gross,
		currency: processConfig?.targetCurrency || processConfig?.currency || 'HUF',
	};
}

// ---- UNAS XML POST ----
async function postXml(pathSeg, xmlBody, bearer) {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}`;
	return axios.post(`${BASE_URL}/${pathSeg}`, xml, {
		headers: {
			'Content-Type': 'text/xml; charset=UTF-8',
			Authorization: `Bearer ${bearer}`,
			'Accept-Encoding': 'gzip,deflate',
		},
		httpAgent: keepAliveHttp,
		httpsAgent: keepAliveHttps,
		timeout: UNAS_TIMEOUT_MS,
		maxContentLength: Infinity,
		maxBodyLength: Infinity,
		decompress: true,
		validateStatus: () => true,
	});
}

/* ============================
   UNAS index építés (determinista)
   ============================ */
const memIndexCache = new Map();
const cacheKeyFor = (shopId, cfg) => `${shopId}:${hash(cfg)}`;

const loadIndexFromFirestore = async (shopId, cfg) => {
	const docId = `${shopId}_${hash(cfg)}`;
	const doc = await db.collection('unasIndexes').doc(docId).get();
	if (!doc.exists) return null;
	const data = doc.data();
	if (!data || !data.updatedAt || !data.pairs) return null;
	const ageMs = Date.now() - new Date(data.updatedAt).getTime();
	const ttlMs = UNAS_INDEX_TTL_HOURS * 60 * 60 * 1000;
	if (ageMs > ttlMs) return null;
	return new Map(Object.entries(data.pairs || {}));
};

const saveIndexToFirestore = async (shopId, cfg, idx) => {
	const docId = `${shopId}_${hash(cfg)}`;
	const obj = Object.fromEntries(idx.entries());
	if (Object.keys(obj).length > 6666) {
		console.warn('[BACKEND] Firestore mentés kihagyva: túl nagy index!');
		return;
	}
	const payload = {
		updatedAt: new Date().toISOString(),
		pairs: obj,
	};
	try {
		await db.collection('unasIndexes').doc(docId).set(payload, { merge: true });
	} catch (e) {
		console.error('[BACKEND] Firestore írás HIBA:', e.message || e);
	}
};

function makeUnasIndex(rows, unasKey) {
	const idx = new Map();
	for (const row of rows) {
		const key = row[unasKey];
		const cikkszam = row['Cikkszám'] || row['sku'] || key;
		idx.set(key, { ...row, sku: cikkszam });
	}
	return idx;
}

async function buildDynamicUnasIndex(shopId, cfg, rows, unasKey) {
	const cKey = cacheKeyFor(shopId, cfg);
	if (memIndexCache.has(cKey)) return memIndexCache.get(cKey);

	// Próbáljuk betölteni Firestore-ból
	const disk = await loadIndexFromFirestore(shopId, cfg);
	if (disk) {
		memIndexCache.set(cKey, disk);
		return disk;
	}

	// Ha nincs cache, építsük fel
	const idx = makeUnasIndex(rows, unasKey);
	memIndexCache.set(cKey, idx);
	// saveIndexToFirestore(shopId, cfg, idx);
	return idx;
}

async function downloadProductDbCsv(bearer, paramsXml) {
	const reqXml =
		paramsXml && paramsXml.trim()
			? paramsXml
			: builder.buildObject({
					Params: {
						Format: 'csv2',
						GetName: 1,
						GetStatus: 1,
						GetPrice: 1,
						GetStock: 1,
						GetParam: 1,
					},
			  });
	const genResp = await postXml('getProductDB', reqXml, bearer);
	if (genResp.status < 200 || genResp.status >= 300) {
		throw new Error(
			`[UNAS] getProductDB hiba: ${genResp.status} ${genResp.statusText}`
		);
	}
	const parsed = await parser.parseStringPromise(genResp.data);
	const downloadUrl =
		parsed?.getProductDB?.Url || parsed?.ProductDB?.Url || parsed?.Url || null;
	if (!downloadUrl)
		throw new Error('[UNAS] getProductDB: hiányzó letöltési URL');

	const fileResp = await axios.get(downloadUrl, {
		responseType: 'arraybuffer',
		validateStatus: () => true,
		timeout: UNAS_DOWNLOAD_TIMEOUT_MS,
	});
	if (fileResp.status < 200 || fileResp.status >= 300) {
		throw new Error(
			`[UNAS] getProductDB fájl letöltési hiba: ${fileResp.status} ${fileResp.statusText}`
		);
	}

	let text = Buffer.from(fileResp.data).toString('utf8');
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const rows = csvParse(text, {
		columns: true,
		skip_empty_lines: true,
		delimiter: ';',
	});
	const header = rows[0] ? Object.keys(rows[0]) : [];


	return { rows, header };
}

// --- Segéd: UNAS termék lekérés SKU alapján (diff-hez) ---
async function fetchProductBySku(bearer, sku) {
	const payload = builder.buildObject({
		Params: { Sku: sku, ContentType: 'full', LimitNum: 1 },
	});
	const resp = await postXml('getProduct', payload, bearer);
	if (resp.status < 200 || resp.status >= 300)
		return { exists: false, product: null };
	try {
		const parsed = await parser.parseStringPromise(resp.data);
		const product =
			parsed?.Products?.Product ||
			parsed?.ProductList?.Products?.Product ||
			parsed?.Product ||
			null;
		if (!product) return { exists: false, product: null };

		const stocks = product?.Stocks?.Stock;
		const stockArr = Array.isArray(stocks) ? stocks : stocks ? [stocks] : [];
		const firstStock = stockArr[0] || {};
		const prices = product?.Prices?.Price;
		const priceArr = Array.isArray(prices) ? prices : prices ? [prices] : [];
		const normalPrice =
			priceArr.find((p) => String(p?.Type || '').toLowerCase() === 'normal') ||
			priceArr[0] ||
			{};

		const before = {
			name: String(product?.Name ?? ''),
			stock: Number(firstStock?.Qty ?? 0) || 0,
			price_net: Number(normalPrice?.Net ?? 0) || 0,
			price_gross: Number(normalPrice?.Gross ?? 0) || 0
		};
		return { exists: true, product, before };
	} catch {
		return { exists: false, product: null };
	}
}

function diffFields(before, after) {
	const changes = {};
	const fields = [
		'name',
		'stock',
		'price_net',
		'price_gross',
		'orderable',
	];
	for (const f of fields) {
		const b = before?.[f];
		const a = after?.[f];
		if ((b ?? null) !== (a ?? null)) {
			changes[f] = { from: b ?? null, to: a ?? null };
		}
	}
	return changes;
}

/* ============================
   Fő feltöltő folyamat
   ============================ */
async function uploadToUnas(records, processConfig, shopConfig) {
	console.log('[DEBUG] Első rekord kulcsai:', Object.keys(records[0] || {}));
	const { dryRun = false, shopId, keyFields } = processConfig;
	const shop = shopConfig || (shopId ? await loadShopById(shopId) : null);
	if (!shop) throw new Error(`[SHOP] Ismeretlen shopId: ${shopId}`);

	const bearer = await getBearerToken(shop.apiKey);
	if (!bearer) throw new Error('[UNAS] Nem sikerült Bearer tokent szerezni.');

	// --- Dinamikus mezőpárosítás ---
	const feedKey = keyFields.feed;
	const unasKey = keyFields.unas;

	console.log(
		`[UNAS] Feltöltés indítása: ${
			records.length
		} rekord, shopId=${shopId}, feedKey=${feedKey}, unasKey=${unasKey}, dryRun=${!!dryRun}`
	);

	// --- UNAS termékek letöltése ---
	const { rows } = await downloadProductDbCsv(
		bearer,
		processConfig.productDbParamsXml
	);
	const unasIndex = await buildDynamicUnasIndex(
		shopId,
		processConfig,
		rows,
		unasKey
	);

	const stats = {
		shopId: shop.shopId,
		shopName: shop.name,
		feedKey,
		unasKey,
		keyFields,
		total: records.length,
		modified: [],
		skippedNoKey: [],
		skippedNotFound: [],
		failed: [],
		dryRun: !!dryRun,
	};
	// console.log(`[UNAS] UNAS index készen áll: ${unasIndex}`);

	for (const rec of records) {
		// console.log(`[UNAS] Feldolgozás: feedKey=${feedKey}, unasKey=${unasKey}`);
		console.log('[UNAS] Rekord:', rec);
		if (!feedKey) {
			stats.skippedNoKey.push({
				key: null,
				reason: `Hiányzik feedKey: ${feedKey}`,
			});
			continue;
		}
		const entry = unasIndex.get(rec[unasKey]);
		console.log('[UNAS] Talált UNAS entry:', entry);
		if (!entry || !entry.sku) {
			stats.skippedNotFound.push({
				key: unasKey,
				reason: `Nem található ${feedKey}-nek megfelelő adat ebben a mezőben: ${unasKey}`,
			});
			continue;
		}
		const unasSku = String(entry.sku).trim();

		// Csak az árakat alakítjuk át
		const { net, gross, currency } = ensureNetGross(rec, processConfig);

		const after = {
			...rec, // minden mező eredeti formában
			price_net: net,
			price_gross: gross,
			currency,
		};

		if (dryRun) {
			stats.modified.push({
				key: feedKey,
				sku: unasSku,
				before: null,
				after,
				changes: after,
			});
			continue;
		}

		// Meglévő UNAS termék lekérése
		let before = null;
		let exists = true;
		try {
			const fetched = await fetchProductBySku(bearer, unasSku);
			exists = fetched.exists;
			before = fetched.before || null;
		} catch {
			exists = true;
		}
		if (!exists) {
			stats.skippedNotFound.push({
				key: unasSku,
				reason: 'Termék nem létezik a shopban (SKU)',
			});
			continue;
		}

		const productNode = { Sku: unasSku };
		if (rec.name != null) productNode.Name = String(rec.name);
		// if (rec.stock != null) {
		// 	const qty = Math.max(0, Math.trunc(Number(rec.stock) || 0));
		// 	productNode.Stocks = { Stock: { Qty: String(qty) } };
		// }

		// Paraméterként adjuk át a "Vásárolható, ha nincs Raktáron" mezőt
		if (rec.orderable !== undefined) {
			const paramKeys = ['Vásárolható, ha nincs Raktáron'];
			const parameters = [];
			for (const key of paramKeys) {
				if (rec[key] !== undefined) {
					parameters.push({
						Name: key,
						Value: String(rec[key]),
					});
				}
			}
			if (parameters.length) {
				productNode.Parameters = parameters;
			}
		}
		productNode.Prices = {
			Price: {
				Type: 'normal',
				Net: toPosNumberString(net),
				Gross: toPosNumberString(gross),
				Currency: currency,
				Actual: '1',
			},
		};

		const changes = diffFields(before || {}, after);

		const payload = builder.buildObject({
			Products: { Product: { Action: 'modify', ...productNode } },
		});

		try {
			const resp = await postXml('setProduct', payload, bearer);
			if (resp.status < 200 || resp.status >= 300) {
				stats.failed.push({
					key: feedKey,
					sku: unasSku,
					unasKey,
					status: resp.status,
					statusText: resp.statusText,
					raw: resp.data,
				});
				continue;
			}
			stats.modified.push({
				key: feedKey,
				sku: unasSku,
				unasKey,
				before,
				after,
				changes,
			});
		} catch (err) {
			stats.failed.push({
				key: feedKey,
				sku: unasSku,
				unasKey,
				status: err?.response?.status || null,
				statusText: err?.response?.statusText || String(err?.message || err),
				raw: err?.response?.data || null,
				error: String(err?.message || err),
			});
		}
	}

	return stats;
}

module.exports = uploadToUnas;
