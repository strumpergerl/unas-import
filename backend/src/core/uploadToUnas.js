// backend/src/core/uploadToUnas.js
require('../bootstrapEnv');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const xml2js = require('xml2js');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { getBearerToken } = require('../services/unas');
const { loadShopById } = require('../services/shops');
const { parse: csvParse } = require('csv-parse/sync');
const { db } = require('../db/firestore');
const { convertCurrency } = require('../utils/currencyConverter');

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
// function ensureCacheDir() {
// 	try {
// 		fs.mkdirSync(CACHE_DIR, { recursive: true });
// 	} catch (_) {}
// }

const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 20 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 20 });

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
	// console.log('[DEBUG] pickFeedKeyValueDynamic', { rec, feedKey });
	return rec?.[feedKey];
}

/** Nettó/Bruttó biztosítása a processConfig alapján */
function ensureNetGross(item, processConfig) {
	const vatPct = Number(processConfig?.vat ?? 27);
	const vatFactor = 1 + (isFinite(vatPct) ? vatPct : 0) / 100;

	const treatLegacyAsGross = formulaHasVat(processConfig?.pricingFormula);

	// --- Árforrások ---
	let inNet = item.price_net != null ? Number(item.price_net) : null;
	let inGross = item.price_gross != null ? Number(item.price_gross) : null;
	let legacy = item.price != null ? Number(item.price) : null;
	let priceCurrency =
		(item.currency || item.deviza || '').toUpperCase() || 'HUF';
	const targetCurrency = (
		processConfig?.targetCurrency ||
		processConfig?.currency ||
		'HUF'
	).toUpperCase();

	// --- Ha nem HUF, először átváltjuk ---
	async function convertIfNeeded(amount) {
		if (!amount || priceCurrency === targetCurrency) return amount;
		return await convertCurrency(amount, priceCurrency, targetCurrency);
	}

	async function compute() {
		// Ár konverzió, ha szükséges
		if (priceCurrency !== targetCurrency) {
			if (inNet != null) inNet = await convertIfNeeded(inNet);
			if (inGross != null) inGross = await convertIfNeeded(inGross);
			if (legacy != null) legacy = await convertIfNeeded(legacy);
			priceCurrency = targetCurrency;
		}

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
			currency: targetCurrency,
		};
	}

	// Mivel a hívó nem async, visszaadunk egy Promise-t, amit a hívó oldalon await-elni kell!
	return compute();
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
	//const doc = await db.collection('unasIndexes').doc(docId).get();
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

async function buildDynamicUnasIndex(shopId, processConfig, rows, unasKey) {
  const idx = new Map();

  for (const row of rows) {
    // kulcs az UNAS-ból: csak TRIM-elt, nem üres értékeket engedünk
    const rawKey = row?.[unasKey];
    const key = rawKey == null ? '' : String(rawKey).trim();
    if (!key) continue;

    // SKU (Cikkszám) kötelező – ne essünk vissza paraméterre!
    const rawSku = row['Cikkszám'] ?? row['SKU'] ?? row['Sku'] ?? row['sku'];
    const sku = rawSku == null ? '' : String(rawSku).trim();
    if (!sku) continue;

    // duplakulcs esetén az utolsó nyer – opcionálisan logolhatsz
    // if (idx.has(key)) console.warn('[UNAS][INDEX] Duplikált kulcs:', key);

    idx.set(key, { ...row, sku });
  }

  console.log('[UNAS][INDEX]', {
    unasKey,
    totalRows: rows.length,
    indexedKeys: idx.size,
    sampleKeys: [...idx.keys()].slice(0, 3),
  });

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

		// DEBUG: log all parameter names and values
		try {
			const paramsDbg = product?.Parameters?.Parameter;
			if (paramsDbg) {
				const arr = Array.isArray(paramsDbg) ? paramsDbg : [paramsDbg];
				// console.log('[UNAS][DEBUG] Paraméterek:');
				for (const p of arr) {
					console.log('  Name:', p?.Name, 'Value:', p?.Value);
				}
			}
			// console.log(
			// 	'[UNAS][DEBUG] Teljes product:',
			// 	JSON.stringify(product, null, 2)
			// );
		} catch (e) {
			console.log('[UNAS][DEBUG] param log error', e);
		}

		const stocks = product?.Stocks?.Stock;
		const stockArr = Array.isArray(stocks) ? stocks : stocks ? [stocks] : [];
		const firstStock = stockArr[0] || {};
		const prices = product?.Prices?.Price;
		const priceArr = Array.isArray(prices) ? prices : prices ? [prices] : [];
		const normalPrice =
			priceArr.find((p) => String(p?.Type || '').toLowerCase() === 'normal') ||
			priceArr[0] ||
			{};

		// --- orderable mező kinyerése ---
		// UNAS API-ban: Stocks.Status.Empty
		let orderable = null;
		if (product?.Stocks?.Status?.Empty !== undefined) {
			orderable = product.Stocks.Status.Empty;
		}

		const before = {
			name: String(product?.Name ?? ''),
			stock: Number(firstStock?.Qty ?? 0) || 0,
			price_net: Number(normalPrice?.Net ?? 0) || 0,
			price_gross: Number(normalPrice?.Gross ?? 0) || 0,
			orderable: orderable,
		};
		return { exists: true, product, before };
	} catch {
		return { exists: false, product: null };
	}
}

function diffFields(before, after) {
	const changes = {};
	const fields = ['name', 'stock', 'price_net', 'price_gross', 'orderable'];
	for (const f of fields) {
		let b = before?.[f];
		let a = after?.[f];

		// Egységes típuskezelés orderable mezőnél
		if (f === 'orderable') {
			b = b === undefined || b === null ? '' : String(b).trim();
			a = a === undefined || a === null ? '' : String(a).trim();
		}
		// Egyéb mezőknél marad a stringes összehasonlítás
		const bStr = b === undefined || b === null ? '' : String(b);
		const aStr = a === undefined || a === null ? '' : String(a);
		if (bStr !== aStr) {
			changes[f] = {
				from: b === undefined ? null : b,
				to: a === undefined ? null : a,
			};
		}
	}
	return changes;
}

/* ============================
   Fő feltöltő folyamat
   ============================ */
async function uploadToUnas(records, processConfig, shopConfig) {
	// ensureCacheDir();
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

	// --- Helper: csak a KERESÉSHEZ trimmelünk (kimenő értékeket nem módosítjuk)
	function pickFeedKeyValueDynamic(rec, feedKey) {
		const v = rec?.[feedKey];
		return v == null ? v : String(v).trim();
	}

	const stats = {
		shopId: shop.shopId,
		shopName: shop.name,
		feedKey,
		unasKey,
		keyFields,
		total: records.length,
		modified: [],
		failed: [],
		// csak számlálók (nem listázunk itemeket a logba)
		skippedNoKeyCount: 0,
		skippedNoChangeCount: 0,
		skippedNotFoundCount: 0,
		dryRun: !!dryRun,
	};
	// console.log(`[UNAS] UNAS index készen áll: ${unasIndex}`);

	for (const rec of records) {
		// 1) feedKey hiánya → SKIP (config probléma)
		if (!feedKey) {
			stats.skippedNoKeyCount++;
			continue;
		}

		// 2) feedKey érték kinyerése
		const feedValue = pickFeedKeyValueDynamic(rec, feedKey);
		if (feedValue == null || feedValue === '') {
			// hiányzó/üres kulcs az adott rekordban → SKIP
			stats.skippedNoKeyCount++;
			continue;
		}

		// 3) UNAS index lookup (NOT FOUND = SKIP, nem megy a logba)
		const entry = unasIndex.get(feedValue);
		if (!entry || !entry.sku) {
			if (stats.skippedNotFoundCount < 5) {
				console.log('[UNAS][SKIP][not-found]', {
					feedKey,
					feedValue,
					unasKey,
					exampleIndexKey: [...unasIndex.keys()].slice(0, 1)[0],
				});
			}
			stats.skippedNotFoundCount++;
			continue;
		}
		const unasSku = String(entry.sku).trim();

		// 4) Ár logika
		let priceValue = null;
		let priceField = processConfig?.priceFields?.feed;
		console.log('[UNAS][DEBUG] priceField from config:', priceField);

		if (
			rec.hasOwnProperty(priceField) &&
			rec[priceField] !== undefined &&
			rec[priceField] !== null &&
			rec[priceField] !== ''
		) {
			const raw = String(rec[priceField]).replace(',', '.');
			const match = raw.match(/([0-9.]+)/);
			if (match) priceValue = parseFloat(match[1]);
		}
		if (!Number.isFinite(priceValue) || priceValue < 0) {
			const msg = `[UNAS][ERROR] Érvénytelen ár a rekordban (sku: ${
				rec.sku || rec['Cikkszám'] || ''
			}, field: ${priceField}, value: ${rec[priceField]})`;
			console.error(msg);
			stats.failed.push({
				key: feedKey,
				sku: unasSku,
				unasKey,
				reason: 'Érvénytelen ár',
				priceField,
				priceValue: rec[priceField],
				message: msg,
			});
			continue;
		}

		// 5) Deviza + konverzió
		const currency = (processConfig?.currency || 'HUF').toUpperCase();
		let priceHuf = priceValue;
		if (currency !== 'HUF') {
			priceHuf = await require('../utils/currencyConverter').convertCurrency(
				priceValue,
				currency,
				'HUF'
			);
		}

		// 6) Nettó/bruttó számítás, kerekítés
		const netGross = await ensureNetGross(
			{ price: priceHuf },
			{ ...processConfig, currency: 'HUF' }
		);
		let net = netGross.net;
		let gross = netGross.gross;

		if (processConfig?.rounding && processConfig.rounding > 0) {
			const factor = Math.max(1, Number(processConfig.rounding) || 0);
			gross = Math.ceil(gross / factor) * factor;
		}

		console.log('[UNAS][DEBUG][computedPrices]', {
			sku: rec.sku || rec['Cikkszám'] || '',
			priceField,
			priceValue,
			currency,
			priceHuf,
			net,
			gross,
		});

		// 7) Orderable (bemeno rekordból átvéve)
		let orderable = rec.orderable;
		console.log('[UNAS][DEBUG][orderable calc]', {
			sku: rec.sku || rec['Cikkszám'] || '',
			orderable: orderable,
		});

		const after = {
			...rec, // minden mező eredeti formában
			price_net: net,
			price_gross: gross,
			currency: currency,
			orderable: orderable,
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

		// 8) Meglévő UNAS termék lekérése (ha mégsem létezne → SKIP NOT FOUND)
		let before = null;
		let exists = true;
		let unasEntry = entry || {};
		try {
			const fetched = await fetchProductBySku(bearer, unasSku);
			exists = fetched.exists;
			before = fetched.before || null;
		} catch {
			exists = true;
		}
		if (!exists) {
			stats.skippedNotFoundCount++;
			continue;
		}

		console.log('[UNAS][DEBUG][közös feed és UNAS index]', {
			sku: rec.sku || rec['Cikkszám'] || '',
			orderable: orderable,
			feedRaw: rec,
		});
		if (unasEntry) {
			let orderableValue = unasEntry['Vásárolható, ha nincs Raktáron'];
			console.log('[UNAS][DEBUG][orderable unasIndex]', {
				sku: unasSku,
				unasOrderable: orderableValue,
				unasEntry,
			});
		}

		// 9) XML payload felépítése
		const productNode = { Sku: unasSku };
		if (rec.name != null) productNode.Name = String(rec.name);

		// orderable → Stocks.Status.Empty + Qty
		if (after.orderable !== undefined && after.orderable !== '') {
			let qtyValue = 0;
			if (rec.hasOwnProperty('stock') && Number.isFinite(Number(rec.stock))) {
				qtyValue = Number(rec.stock);
			} else if (
				rec.hasOwnProperty('qty') &&
				Number.isFinite(Number(rec.qty))
			) {
				qtyValue = Number(rec.qty);
			}
			productNode.Stocks = {
				Status: {
					Active: '1',
					Empty: String(after.orderable),
				},
				Stock: {
					Qty: qtyValue,
				},
			};
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

		// 10) Diff és "nincs változás" kezelése → számláló
		const changes = diffFields(before || {}, after);
		if (!changes || Object.keys(changes).length === 0) {
			stats.skippedNoChangeCount++;
			continue;
		}

		const payload = builder.buildObject({
			Products: { Product: { Action: 'modify', ...productNode } },
		});

		// Debug: log the full XML payload before sending
		//console.log('[UNAS][DEBUG][XML payload]', { sku: unasSku, payload });

		// 11) UNAS update
		try {
			const resp = await postXml('setProduct', payload, bearer);
			console.log('[UNAS][DEBUG][UNAS response]', {
				sku: unasSku,
				status: resp.status,
				statusText: resp.statusText,
				data: resp.data,
			});
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
			console.error('[UNAS][DEBUG][UNAS error]', {
				sku: unasSku,
				error: err?.message,
				response: err?.response?.data,
			});
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

	console.log('[UNAS][STATS][summary]', {
		total: stats.total,
		modified: stats.modified.length,
		failed: stats.failed.length,
		skippedNoKey: stats.skippedNoKeyCount,
		skippedNoChange: stats.skippedNoChangeCount,
		skippedNotFound: stats.skippedNotFoundCount,
	});

	return stats;
}

module.exports = uploadToUnas;
