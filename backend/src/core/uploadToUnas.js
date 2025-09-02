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

const CACHE_DIR = path.join(process.cwd(), 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 20 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ---- Közös utilok ----
const norm = (s) => String(s ?? '').trim();
const normKey = (v, ci = true) => {
	const s = String(v ?? '').trim();
	return ci ? s.toLowerCase() : s;
};
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
   MATCH – szigorú kulcspár-kezelés
   ============================ */
function validateStrictMatchConfig(cfg) {
	if (!cfg.feedKey) throw new Error('[MATCH] feedKey kötelező.');
	if (!['sku', 'barcode', 'parameter'].includes(cfg.unasField)) {
		throw new Error('[MATCH] unasField csak sku|barcode|parameter lehet.');
	}
	if (cfg.source === 'productdb' && !cfg.productDbHeader) {
		throw new Error(
			'[MATCH] productdb forrásnál a productDbHeader kötelező (pontos fejlécszöveg).'
		);
	}
	if (
		cfg.unasField === 'parameter' &&
		cfg.source !== 'productdb' &&
		!cfg.unasParamId
	) {
		throw new Error('[MATCH] parameter esetén crawl-nál unasParamId kötelező.');
	}
}
function deriveMatchFromKeyFields(keyFields) {
	if (!keyFields || typeof keyFields !== 'object') return null;
	const feedKey = String(keyFields.feed || keyFields.feedKey || '').trim();
	const unasKey = String(keyFields.unas || keyFields.unasKey || '').trim();
	if (!feedKey || !unasKey) return null;

	const u = unasKey.toLowerCase();
	if (['sku', 'cikkszám', 'cikkszam'].includes(u)) {
		const cfg = {
			feedKey,
			unasField: 'sku',
			source: 'crawl',
			caseInsensitive: true,
		};
		validateStrictMatchConfig(cfg);
		return cfg;
	}
	if (['barcode', 'ean', 'vonalkód', 'vonalkod'].includes(u)) {
		const cfg = {
			feedKey,
			unasField: 'barcode',
			source: 'crawl',
			caseInsensitive: true,
		};
		validateStrictMatchConfig(cfg);
		return cfg;
	}
	const cfg = {
		feedKey,
		unasField: 'parameter',
		productDbHeader: String(unasKey),
		source: 'productdb',
		caseInsensitive: true,
	};
	validateStrictMatchConfig(cfg);
	return cfg;
}
function deriveMatchFromFieldMapping(fieldMapping) {
	const list = Array.isArray(fieldMapping)
		? fieldMapping
		: Array.isArray(fieldMapping?.fields)
		? fieldMapping.fields
		: [];
	if (!list.length) return null;

	const keyItems = list.filter(
		(it) => it && (it.keyField || it.isKey || it.key || it.isKeyField)
	);
	if (!keyItems.length) return null;

	const active =
		keyItems.find(
			(it) => it.active || it.selected || it.isActive || it.primary
		) || keyItems[0];
	const cfg = {
		feedKey: String(active.feedKey || '').trim(),
		unasField: String(active.unasField || '').trim(),
		productDbHeader: String(active.productDbHeader || '').trim(),
		unasParamId: String(active.unasParamId || '').trim(),
		source: String(active.source || 'auto').trim(),
		caseInsensitive: active.caseInsensitive !== false,
		selectedId: active.id || null,
	};
	if (!cfg.source || cfg.source === 'auto')
		cfg.source = cfg.productDbHeader ? 'productdb' : 'crawl';
	validateStrictMatchConfig(cfg);
	return cfg;
}
function getStrictMatchConfig(processConfig = {}) {
	const m = processConfig.match || {};
	if (Array.isArray(m.pairs) && m.pairs.length) {
		let pair = null;
		if (Number.isInteger(m.activeIndex)) pair = m.pairs[m.activeIndex] || null;
		else if (m.selected != null) {
			const sel = String(m.selected);
			pair = m.pairs.find((p) => String(p.id || p.name || '') === sel) || null;
		} else pair = m.pairs.find((p) => p && p.selected === true) || m.pairs[0];

		const cfg = {
			feedKey: String(pair.feedKey || '').trim(),
			unasField: String(pair.unasField || '').trim(),
			productDbHeader: String(pair.productDbHeader || '').trim(),
			unasParamId: String(pair.unasParamId || '').trim(),
			source: String(pair.source || 'auto').trim(),
			caseInsensitive: pair.caseInsensitive !== false,
			selectedId: pair.id || pair.name || null,
		};
		if (!cfg.source || cfg.source === 'auto')
			cfg.source = cfg.productDbHeader ? 'productdb' : 'crawl';
		validateStrictMatchConfig(cfg);
		return cfg;
	}
	if (m.feedKey && m.unasField) {
		const cfg = {
			feedKey: String(m.feedKey).trim(),
			unasField: String(m.unasField).trim(),
			productDbHeader: String(m.productDbHeader || '').trim(),
			unasParamId: String(m.unasParamId || '').trim(),
			source: String(m.source || 'auto').trim(),
			caseInsensitive: m.caseInsensitive !== false,
			selectedId: m.id || null,
		};
		if (!cfg.source || cfg.source === 'auto')
			cfg.source = cfg.productDbHeader ? 'productdb' : 'crawl';
		validateStrictMatchConfig(cfg);
		return cfg;
	}
	const fromKF = deriveMatchFromKeyFields(processConfig.keyFields);
	if (fromKF) return fromKF;
	const fromFM = deriveMatchFromFieldMapping(processConfig.fieldMapping);
	if (fromFM) return fromFM;

	throw new Error(
		'[MATCH] Nincs beállítva kulcspár. Állíts be keyFields-et (feed + unas), vagy add meg a match.pairs-t.'
	);
}

/* ============================
   UNAS index építés (determinista)
   ============================ */
const memIndexCache = new Map();
const cacheKeyFor = (shopId, cfg) => `${shopId}:${hash(cfg)}`;
const indexCacheFile = (shopId, cfg) =>
	path.join(CACHE_DIR, `unasIndex.${shopId}.${hash(cfg)}.json`);

function loadIndexFromDisk(shopId, cfg) {
	const file = indexCacheFile(shopId, cfg);
	if (!fs.existsSync(file)) return null;
	try {
		const raw = fs.readFileSync(file, 'utf8');
		const data = JSON.parse(raw);
		const ageMs = Date.now() - new Date(data.updatedAt).getTime();
		const ttlMs = UNAS_INDEX_TTL_HOURS * 60 * 60 * 1000;
		if (ageMs > ttlMs) return null;
		return new Map(Object.entries(data.pairs || {}));
	} catch {
		return null;
	}
}
function saveIndexToDisk(shopId, cfg, idx) {
	const file = indexCacheFile(shopId, cfg);
	const obj = Object.fromEntries(idx.entries());
	fs.writeFileSync(
		file,
		JSON.stringify({ updatedAt: new Date().toISOString(), pairs: obj }),
		'utf8'
	);
}

function buildIndexFromProductDbStrict(rows, _header, cfg) {
	const idx = new Map();
	for (const r of rows) {
		const keyRaw = r[cfg.productDbHeader];
		const sku = r['Sku'];
		if (!keyRaw || !sku) continue;
		idx.set(normKey(keyRaw, cfg.caseInsensitive), { sku: String(sku).trim() });
	}
	return idx;
}
function buildIndexFromCrawlStrict(productList, cfg) {
	const idx = new Map();
	for (const p of productList) {
		const sku = String(p?.Sku || p?.SKU || '').trim();
		if (!sku) continue;

		if (cfg.unasField === 'sku') {
			idx.set(normKey(sku, cfg.caseInsensitive), { sku });
			continue;
		}
		if (cfg.unasField === 'barcode') {
			const ean = String(p?.Barcode || p?.EAN || '').trim();
			if (ean) idx.set(normKey(ean, cfg.caseInsensitive), { sku });
		}
		if (cfg.unasField === 'parameter') {
			const addMatches = (params, vSku) => {
				const arr = Array.isArray(params) ? params : params ? [params] : [];
				for (const it of arr) {
					const id = String(it?.Id ?? it?.ID ?? '').trim();
					if (
						cfg.source !== 'productdb' &&
						cfg.unasParamId &&
						id !== cfg.unasParamId
					)
						continue;
					const val = String(it?.Value ?? it?._ ?? '').trim();
					if (!val) continue;
					idx.set(normKey(val, cfg.caseInsensitive), { sku: vSku });
				}
			};
			addMatches(p?.Parameters?.Parameter || p?.Params?.Param, sku);

			const variants = p?.Variants?.Variant;
			const vArr = Array.isArray(variants)
				? variants
				: variants
				? [variants]
				: [];
			for (const v of vArr) {
				const vSku = String(v?.Sku ?? v?.VariantSku ?? sku).trim();
				addMatches(v?.Parameters?.Parameter || v?.Params?.Param, vSku);
			}
		}
	}
	return idx;
}

async function downloadProductDbCsv(bearer) {
	const reqXml = builder.buildObject({
		Params: {
			Format: 'csv2',
			GetParam: 1,
			GetPrice: 1,
			GetStock: 1,
			Compress: 'no',
			Lang: 'hu',
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

async function crawlAllProducts(bearer) {
	const all = [];
	const limit = 500;
	let start = 0;
	for (;;) {
		const req = builder.buildObject({
			Params: {
				LimitNum: String(limit),
				LimitStart: String(start),
				ContentType: 'full',
			},
		});
		const resp = await postXml('getProduct', req, bearer);
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(
				`[UNAS] getProduct crawl hiba: ${resp.status} ${resp.statusText}`
			);
		}
		const parsed = await parser.parseStringPromise(resp.data);
		let products =
			parsed?.Products?.Product ||
			parsed?.ProductList?.Products?.Product ||
			parsed?.Product ||
			[];
		if (!Array.isArray(products)) products = products ? [products] : [];
		if (products.length === 0) break;
		all.push(...products);
		start += products.length;
		if (products.length < limit) break;
	}
	return all;
}

async function buildUnasIndexStrict(bearer, shopId, cfg) {
	const cKey = cacheKeyFor(shopId, cfg);
	if (memIndexCache.has(cKey)) return memIndexCache.get(cKey);

	const disk = loadIndexFromDisk(shopId, cfg);
	if (disk) {
		memIndexCache.set(cKey, disk);
		return disk;
	}

	let idx = new Map();
	if (cfg.source === 'productdb') {
		let lastErr = null;
		for (let i = 0; i < UNAS_PRODUCTDB_MAX_RETRIES; i++) {
			try {
				const { rows, header } = await downloadProductDbCsv(bearer);
				idx = buildIndexFromProductDbStrict(rows, header, cfg);
				lastErr = null;
				break;
			} catch (e) {
				lastErr = e;
				await sleep(UNAS_PRODUCTDB_BACKOFF_MS * (i + 1));
			}
		}
		if (lastErr) throw lastErr;
	} else if (cfg.source === 'crawl') {
		const products = await crawlAllProducts(bearer);
		idx = buildIndexFromCrawlStrict(products, cfg);
	} else {
		if (cfg.productDbHeader) {
			try {
				const { rows, header } = await downloadProductDbCsv(bearer);
				idx = buildIndexFromProductDbStrict(rows, header, cfg);
			} catch {
				const products = await crawlAllProducts(bearer);
				idx = buildIndexFromCrawlStrict(products, cfg);
			}
		} else {
			const products = await crawlAllProducts(bearer);
			idx = buildIndexFromCrawlStrict(products, cfg);
		}
	}
	memIndexCache.set(cKey, idx);
	saveIndexToDisk(shopId, cfg, idx);
	return idx;
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
			description: String(product?.Description ?? ''),
			stock: Number(firstStock?.Qty ?? 0) || 0,
			price_net: Number(normalPrice?.Net ?? 0) || 0,
			price_gross: Number(normalPrice?.Gross ?? 0) || 0,
			currency: String(normalPrice?.Currency ?? '') || null,
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
		'description',
		'stock',
		'price_net',
		'price_gross',
		'currency',
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
	const { dryRun = false, shopId } = processConfig;

	const shop = shopConfig || loadShopById(shopId);
	if (!shop) throw new Error(`[SHOP] Ismeretlen shopId: ${shopId}`);

	const bearer = await getBearerToken(shop.apiKey);
	if (!bearer) throw new Error('[UNAS] Nem sikerült Bearer tokent szerezni.');

	// --- Szigorú match (match.pairs / match / keyFields / .field-mapping) ---
	const matchCfg = getStrictMatchConfig(processConfig);

	// --- UNAS index (ha kell) ---
	let unasIndex = null;
	if (matchCfg.unasField !== 'sku') {
		unasIndex = await buildUnasIndexStrict(bearer, shop.shopId, matchCfg);
	}

	const stats = {
		shopId: shop.shopId,
		shopName: shop.name,
		match: matchCfg,
		total: records.length,
		modified: [], // { key, sku, before, after, changes }
		skippedNoKey: [], // { key, reason }
		skippedNotFound: [], // { key, reason }
		failed: [], // { key, sku, error, status, statusText, raw }
		dryRun: !!dryRun,
	};

	if (dryRun) {
		// Dry run: csak „tervezett” after állapotokat és kulcsokat adjuk vissza
		for (const rec of records) {
			const keyRaw = rec[matchCfg.feedKey];
			if (!keyRaw) {
				stats.skippedNoKey.push({
					key: null,
					reason: `Hiányzik feedKey: ${matchCfg.feedKey}`,
				});
				continue;
			}
			let unasSku = null;
			if (matchCfg.unasField === 'sku') {
				unasSku = norm(keyRaw);
			} else {
				const entry = unasIndex?.get(normKey(keyRaw, matchCfg.caseInsensitive));
				unasSku = entry?.sku || null;
			}
			if (!unasSku) {
				stats.skippedNotFound.push({
					key: keyRaw,
					reason: 'UNAS SKU nem található (index alapján)',
				});
				continue;
			}
			const { net, gross, currency } = ensureNetGross(rec, processConfig);
			const after = {
				name: rec.name != null ? String(rec.name) : undefined,
				description:
					rec.description != null ? String(rec.description) : undefined,
				stock:
					rec.stock != null
						? Math.max(0, Math.trunc(Number(rec.stock) || 0))
						: undefined,
				price_net: net,
				price_gross: gross,
				currency,
			};
			stats.modified.push({
				key: keyRaw,
				sku: unasSku,
				before: null,
				after,
				changes: after,
			});
		}
		return stats;
	}

	// --- Feltöltési ciklus ---
	for (const rec of records) {
		const keyRaw = rec[matchCfg.feedKey];
		if (!keyRaw) {
			stats.skippedNoKey.push({
				key: null,
				reason: `Hiányzik feedKey: ${matchCfg.feedKey}`,
			});
			continue;
		}

		// SKU meghatározása
		let unasSku = null;
		if (matchCfg.unasField === 'sku') {
			unasSku = norm(keyRaw);
		} else {
			const key = normKey(keyRaw, matchCfg.caseInsensitive);
			const entry = unasIndex.get(key);
			if (!entry || !entry.sku) {
				stats.skippedNotFound.push({
					key: keyRaw,
					reason: 'UNAS SKU nem található (index alapján)',
				});
				continue;
			}
			unasSku = String(entry.sku).trim();
		}

		// Meglévő UNAS termék lekérése → before
		let before = null;
		let exists = true;
		try {
			const fetched = await fetchProductBySku(bearer, unasSku);
			exists = fetched.exists;
			before = fetched.before || null;
		} catch {
			exists = true; // ha lekérés hibás, nem állítjuk le a folyamatot
		}
		if (!exists) {
			stats.skippedNotFound.push({
				key: unasSku,
				reason: 'Termék nem létezik a shopban (SKU)',
			});
			continue;
		}

		// After állapot összerakása a feltöltendőből
		const productNode = { Sku: unasSku };
		if (rec.name != null) productNode.Name = String(rec.name);
		if (rec.description != null)
			productNode.Description = String(rec.description);
		if (rec.stock != null) {
			const qty = Math.max(0, Math.trunc(Number(rec.stock) || 0));
			productNode.Stocks = { Stock: { Qty: String(qty) } };
		}
		const { net, gross, currency } = ensureNetGross(rec, processConfig);
		productNode.Prices = {
			Price: {
				Type: 'normal',
				Net: toPosNumberString(net),
				Gross: toPosNumberString(gross),
				Currency: currency,
				Actual: '1',
			},
		};

		const after = {
			name: productNode.Name ?? before?.name ?? undefined,
			description: productNode.Description ?? before?.description ?? undefined,
			stock:
				productNode.Stocks?.Stock?.Qty != null
					? Number(productNode.Stocks.Stock.Qty)
					: before?.stock ?? undefined,
			price_net: Number(productNode.Prices.Price.Net),
			price_gross: Number(productNode.Prices.Price.Gross),
			currency: productNode.Prices.Price.Currency,
		};
		const changes = diffFields(before || {}, after);

		// setProduct (modify)
		const payload = builder.buildObject({
			Products: { Product: { Action: 'modify', ...productNode } },
		});

		try {
			const resp = await postXml('setProduct', payload, bearer);
			if (resp.status < 200 || resp.status >= 300) {
				stats.failed.push({
					key: keyRaw,
					sku: unasSku,
					status: resp.status,
					statusText: resp.statusText,
					raw: resp.data,
				});
				continue;
			}
			stats.modified.push({
				key: keyRaw,
				sku: unasSku,
				before,
				after,
				changes,
			});
		} catch (err) {
			stats.failed.push({
				key: keyRaw,
				sku: unasSku,
				status: err?.response?.status || null,
				statusText: err?.response?.statusText || String(err?.message || err),
				raw: err?.response?.data || null,
				error: String(err?.message || err),
			});
		}
	}

	if (unasIndex) saveIndexToDisk(shop.shopId, matchCfg, unasIndex);
	return stats;
}

module.exports = uploadToUnas;
