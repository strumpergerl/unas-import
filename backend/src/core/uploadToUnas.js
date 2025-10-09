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
const { canonicalizeKey } = require('../utils/key');
const { matchByExactKey } = require('../utils/strictMatch');
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

const SUPPLIER_PARAM_NAME = 'Beszerezhető - Csak nekünk';

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 20 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 20 });

const toPosNumberString = (v, decimals = null) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return '0';
	const p = Math.max(0, n);
	return decimals == null ? String(p) : p.toFixed(decimals);
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

const formulaHasShipping = (formula) =>
	typeof formula === 'string' && /\{shipping\}/i.test(formula);

const PRICING_TOKEN_REGEX = /(\{basePrice\}|\{priceMargin\}|\{priceMarginPercent\}|\{priceMarginFactor\}|\{discount\}|\{discountPercent\}|\{discountMultiplier\}|\{vat\}|\{vatPercent\}|\{shipping\}|\+|\-|\*|\/|\(|\)|\s+|\d+(?:\.\d+)?)/g;

function evaluatePricingFormula(formula, values = {}) {
	if (!formula || typeof formula !== 'string') return null;
	const tokens = formula.match(PRICING_TOKEN_REGEX);
	if (!Array.isArray(tokens) || tokens.length === 0) return null;
	const replacers = {
		'{basePrice}': values.basePrice,
		'{shipping}': values.shipping,
		'{priceMargin}': values.priceMargin,
		'{priceMarginPercent}': values.priceMarginPercent,
		'{priceMarginFactor}': values.priceMarginFactor,
		'{discount}': values.discount,
		'{discountPercent}': values.discountPercent,
		'{discountMultiplier}': values.discountMultiplier,
		'{vat}': values.vat,
		'{vatPercent}': values.vatPercent,
	};
	let expression = '';
	for (const token of tokens) {
		if (!token.trim()) continue;
		if (token in replacers) {
			const num = Number(replacers[token]);
			expression += Number.isFinite(num) ? String(num) : '0';
			continue;
		}
		if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
			expression += token;
			continue;
		}
		if (/^[+\-*/()]$/.test(token)) {
			expression += token;
			continue;
		}
		return null;
	}
	const sanitized = expression.replace(/\s+/g, '');
	if (!sanitized || /[^0-9.+\-*/()]/.test(sanitized)) return null;
	try {
		const result = Function('"use strict"; return (' + sanitized + ');')();
		return Number.isFinite(result) ? result : null;
	} catch (_) {
		return null;
	}

}

function parseNumSmart(v) {
	if (v == null) return null;
	let s = String(v).trim().toLowerCase();
	// egység eltávolítás (kg, g)
	s = s.replace(/\s+/g, '');
	if (s.endsWith('kg')) s = s.slice(0, -2);
	if (s.endsWith('g')) {
		const num = Number(s.slice(0, -1).replace(',', '.'));
		return Number.isFinite(num) ? num / 1000 : null;
	}
	s = s.replace(',', '.');
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

// Súly kigyűjtése
function pickWeightFromConfigured(rec, unasEntry, processConfig) {
	const feedKey = processConfig?.weightFields?.feed;
	const unasKey = processConfig?.weightFields?.unas;

	// 1) FEED
	if (feedKey && rec && rec[feedKey] != null) {
		const n = parseNumSmart(rec[feedKey]);
		if (n != null && n > 0) return n;
	}
	// 2) UNAS index
	if (unasKey && unasEntry && unasEntry[unasKey] != null) {
		const n = parseNumSmart(unasEntry[unasKey]);
		if (n != null && n > 0) return n;
	}
	return null;
}

// Szállítási komponens kalkuláció (Ft vagy Ft/kg * kg)
function calcShippingComponentHuf({ shippingType, shippingValue, weight }) {
	const val = Number(shippingValue) || 0;
	if (val <= 0) return 0;
	if (shippingType === 'weight') {
		if (weight == null) return null; // jelöljük, hogy hiányzik
		return val * weight;
	}
	return val; // fixed
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

		net = Math.max(0, net);
		gross = Math.max(0, gross);

		return {
			net,
			gross,
			currency: targetCurrency,
		};
	}

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

async function buildDynamicUnasIndex(
	shopId,
	processConfig,
	rows,
	unasKey,
	{ caseSensitive = true } = {}
) {
	const idx = new Map();

	for (const row of rows) {
		// kulcs az UNAS-ból
		const rawKey = row?.[unasKey];
		const key = canonicalizeKey(rawKey, { caseSensitive });
		if (!key) continue;

		// SKU (Cikkszám) kötelező - ne essünk vissza paraméterre!
		const rawSku = row['Cikkszám'] ?? row['SKU'] ?? row['Sku'] ?? row['sku'];
		const sku = rawSku == null ? '' : String(rawSku).trim();
		if (!sku) continue;

		// duplakulcs esetén az utolsó nyer - opcionálisan logolhatsz
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

function stringOrNull(raw) {
	if (raw === undefined || raw === null) return null;
	const str = String(raw);
	return str.length ? str : null;
}

function collectParamEntriesFromStructure(node, acc = []) {
	if (!node) return acc;
	if (Array.isArray(node)) {
		for (const item of node) {
			collectParamEntriesFromStructure(item, acc);
		}
		return acc;
	}
	if (typeof node !== 'object') return acc;

	const hasName = Object.prototype.hasOwnProperty.call(node, 'Name');
	const hasValue = Object.prototype.hasOwnProperty.call(node, 'Value');
	if (hasName && hasValue) {
		acc.push({ name: node.Name, value: node.Value });
	}

	for (const child of Object.values(node)) {
		if (child && (Array.isArray(child) || typeof child === 'object')) {
			collectParamEntriesFromStructure(child, acc);
		}
	}

	return acc;
}

function parseParamKeyValueText(text) {
	const entries = [];
	const str = stringOrNull(text);
	if (!str) return entries;

	const groups = str.split(/\s*;\s*/);
	for (const group of groups) {
		if (!group) continue;
		const tokens = group.split(/\s*\|\s*/);
		let name = null;
		let value = null;

		for (const token of tokens) {
			if (!token) continue;
			const kv = token.split(/\s*[:=]\s*/, 2);
			if (kv.length !== 2) continue;
			const key = kv[0]?.trim();
			const val = kv[1] ?? '';
			if (!key) continue;
			if (key === 'Name') {
				name = val;
			} else if (key === 'Value') {
				value = val;
			}
		}

		if (name != null && value != null) {
			entries.push({ name, value });
		}
	}

	return entries;
}

function extractParamValueFromStructured(source, paramName) {
	if (source === undefined || source === null) return null;

	if (typeof source === 'object') {
		const entries = collectParamEntriesFromStructure(source, []);
		for (const entry of entries) {
			if (entry?.name === paramName) {
				return stringOrNull(entry.value);
			}
		}
		return null;
	}

	const text = String(source);
	const trimmed = text.trim();
	if (!trimmed) return null;

	if (/^[\[{]/.test(trimmed)) {
		try {
			const parsed = JSON.parse(trimmed);
			const value = extractParamValueFromStructured(parsed, paramName);
			if (value != null) return value;
		} catch (_) {
			// ignore JSON parse errors
		}
	}

	const pairs = parseParamKeyValueText(trimmed);
	for (const pair of pairs) {
		if (pair.name === paramName) {
			return stringOrNull(pair.value);
		}
	}

	return null;
}

function extractSupplierParamValue(row, paramName = SUPPLIER_PARAM_NAME) {
	if (!row || typeof row !== 'object') return null;

	const direct = stringOrNull(row[paramName]);
	if (direct != null) return direct;

	const namesById = new Map();
	const valuesById = new Map();
	const paramColumnPrefix = `Paraméter: ${paramName}|`;

	for (const [rawKey, rawValue] of Object.entries(row)) {
		const key = rawKey == null ? '' : String(rawKey);
		if (!key) continue;

		if (key === paramName) {
			const value = stringOrNull(rawValue);
			if (value != null) return value;
			continue;
		}

		if (key === 'Param' || key === 'Params' || key === 'Parameter') {
			const value = extractParamValueFromStructured(rawValue, paramName);
			if (value != null) return value;
			continue;
		}

		if (key.startsWith(paramColumnPrefix)) {
			const value = stringOrNull(rawValue);
			if (value != null) return value;
			continue;
		}

		const nameMatch =
			key.match(/^ParamName\[(\d+)\]$/) ||
			key.match(/^Param\[(\d+)\]\s*Name$/);
		if (nameMatch) {
			const value = stringOrNull(rawValue);
			if (value != null) namesById.set(nameMatch[1], value);
			continue;
		}

		const valueMatch =
			key.match(/^ParamValue\[(\d+)\]$/) ||
			key.match(/^Param\[(\d+)\]\s*Value$/);
		if (valueMatch) {
			const value = stringOrNull(rawValue);
			if (value != null) valuesById.set(valueMatch[1], value);
			continue;
		}

		if (key.startsWith('Param')) {
			const value = extractParamValueFromStructured(rawValue, paramName);
			if (value != null) return value;
		}
	}

	for (const [id, name] of namesById.entries()) {
		if (name === paramName) {
			const value = valuesById.get(id);
			if (value != null) return value;
		}
	}

	return null;
}

function filterProductDbRowsBySupplier(
	rows,
	supplierName,
	paramName = SUPPLIER_PARAM_NAME
) {
	if (!Array.isArray(rows) || !rows.length) {
		return {
			filteredRows: [],
			stats: { missingSupplierParam: 0, mismatchedSupplier: 0 },
		};
	}

	const supplierValue = stringOrNull(supplierName);
	if (!supplierValue) {
		return {
			filteredRows: [...rows],
			stats: { missingSupplierParam: 0, mismatchedSupplier: 0 },
		};
	}

	const filteredRows = [];
	const stats = { missingSupplierParam: 0, mismatchedSupplier: 0 };

	for (const row of rows) {
		const supplierInRow = extractSupplierParamValue(row, paramName);
		if (supplierInRow == null) {
			stats.missingSupplierParam += 1;
			continue;
		}
		if (supplierInRow === supplierValue) {
			filteredRows.push(row);
		} else {
			stats.mismatchedSupplier += 1;
		}
	}

	return { filteredRows, stats };
}

function extractParamNameFromColumnLabel(label) {
	if (typeof label !== 'string' || !label.includes(':')) return null;
	const pipeIndex = label.indexOf('|');
	const head = pipeIndex === -1 ? label : label.slice(0, pipeIndex);
	const [prefix, ...rest] = head.split(':');
	if (!prefix || rest.length === 0) return null;

	const normalizedPrefix = prefix
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
	if (normalizedPrefix !== 'parameter') return null;

	const name = rest.join(':').trim();
	return name || null;
}

function collectParamNamesFromConfig(processConfig) {
	const names = new Set();
	const supplierName =
		stringOrNull(processConfig?.supplierParamName) || SUPPLIER_PARAM_NAME;
	if (supplierName) names.add(supplierName);

	const visited = new Set();
	function walk(value) {
		if (value == null) return;
		if (typeof value === 'string') {
			const name = extractParamNameFromColumnLabel(value);
			if (name) names.add(name);
			return;
		}
		if (typeof value !== 'object') return;
		if (visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
		} else {
			for (const item of Object.values(value)) walk(item);
		}
	}

	walk(processConfig);
	return names;
}

function mapParamNamesToIds(rows, names) {
	const remaining = new Set(names || []);
	const nameToId = new Map();
	if (!remaining.size || !Array.isArray(rows)) return nameToId;

	for (const row of rows) {
		if (!row || remaining.size === 0) break;
		for (const [key, value] of Object.entries(row)) {
			const match = /^ParamName\[(\d+)]$/.exec(key);
			if (!match) continue;
			const paramName = stringOrNull(value);
			if (!paramName) continue;
			if (remaining.has(paramName)) {
				nameToId.set(paramName, match[1]);
				remaining.delete(paramName);
				if (remaining.size === 0) break;
			}
		}
	}

	return nameToId;
}

function computeContentParamIds(rows, processConfig) {
	const paramNames = collectParamNamesFromConfig(processConfig);
	if (!paramNames.size) return [];
	const nameToId = mapParamNamesToIds(rows, paramNames);
	const missing = Array.from(paramNames).filter((name) => !nameToId.has(name));
	if (missing.length) {
		console.warn('[UNAS][WARN] ContentParam azonosító nem található az alábbi paraméterekhez:', {
			paramNames: missing,
		});
	}
	const ids = Array.from(new Set(Array.from(nameToId.values())));

	return ids;
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
				GetWeight: 1,
				GetId: 1,
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
async function fetchProductBySku(bearer, sku, { paramIds } = {}) {
	const filteredParamIds = Array.isArray(paramIds)
		? paramIds
				.map((id) => {
					const str = String(id || '').trim();
					return /^\d+$/.test(str) ? str : null;
				})
				.filter(Boolean)
		: [];
	const paramsPayload = { Sku: sku, ContentType: 'full', LimitNum: 1 };
	if (filteredParamIds.length) {
		paramsPayload.ContentParam = filteredParamIds.join(',');
	}
	const payload = builder.buildObject({
		Params: paramsPayload,
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
	const fields = Object.keys(after || {});

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

	if (!feedKey || !unasKey) {
		throw new Error(
			`[CONFIG] keyFields hiányos: feed="${feedKey}", unas="${unasKey}"`
		);
	}
	if (records.length) {
		const k0 = Object.keys(records[0]);
		if (!k0.includes(feedKey)) {
			throw new Error(
				`[DATA] A transzformált rekordok nem tartalmazzák a feed kulcsot: "${feedKey}". (Első rekord kulcsai: ${k0.join(
					', '
				)})`
			);
		}
	}

	// --- UNAS termékek letöltése ---
	const productDb = await downloadProductDbCsv(
		bearer,
		processConfig.productDbParamsXml
	);
	const header = productDb?.header || [];
	const allRows = Array.isArray(productDb?.rows) ? productDb.rows : [];
	let rows = allRows;
	if (!Array.isArray(header) || !header.includes(unasKey)) {
		throw new Error(
			`[UNAS] A ProductDB fejléc nem tartalmazza a kiválasztott UNAS kulcsot: "${unasKey}". (Fejléc minta: ${
				header?.slice?.(0, 8)?.join(', ') || 'n/a'
			})`
	);
}

	const contentParamIds = computeContentParamIds(allRows, processConfig);

	const supplierName = processConfig?.supplierName;
	if (supplierName) {
		const { filteredRows, stats } = filterProductDbRowsBySupplier(
			rows,
			supplierName
		);

		console.log('[UNAS][FILTER][supplier]', {
			paramName: SUPPLIER_PARAM_NAME,
			supplierName,
			totalRows: rows.length,
			keptRows: filteredRows.length,
			droppedMissingParam: stats.missingSupplierParam,
			droppedMismatchedSupplier: stats.mismatchedSupplier,
		});

		rows = filteredRows;
	}

	const unasIndex = await buildDynamicUnasIndex(
		shopId,
		processConfig,
		rows,
		unasKey
	);

	// --- Helper függvény: feedKey érték kinyerése dinamikusan ---
	function pickFeedKeyValue(rec, feedKey, { caseSensitive = true } = {}) {
		return canonicalizeKey(rec?.[feedKey], { caseSensitive });
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
		const feedValue = pickFeedKeyValue(rec, feedKey, { caseSensitive: true });

		if (feedValue == null || feedValue === '') {
			// hiányzó/üres kulcs az adott rekordban → SKIP
			stats.skippedNoKeyCount++;
			continue;
		}

		// 3) UNAS index lookup (NOT FOUND = SKIP, nem megy a logba)
		const { entry } = matchByExactKey(
			{ [feedKey]: feedValue },
			unasIndex,
			feedKey,
			{ caseSensitive: true }
		);

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

		const includesShipping = formulaHasShipping(processConfig?.pricingFormula || '');
		const includesVat      = formulaHasVat(processConfig?.pricingFormula || '');
		
		const requiresWeight =
			includesShipping && (processConfig?.shippingType || 'fixed') === 'weight';
		// --- Súly és szállítás ---
		const wf = processConfig?.weightFields || {};

		if (requiresWeight && !wf.feed && !wf.unas) {
			// Nincs beállítva honnan vegyük a súlyt → konfigurációs hiba
			stats.failed.push({
				key: feedKey,
				sku: unasSku,
				unasKey,
				reason: 'Hiányzó súly mezőpár (config)',
				message:
					'[UNAS][ERROR] Súly alapú szállítást kértél, de a weightFields.feed/unas nincs beállítva a processConfig-ban.',
				error: '[súly] Hiányzó weightFields feed/unas a konfigurációban',
			});
			continue;
		}

		const weight = pickWeightFromConfigured(rec, entry, processConfig);

		const shippingAmountOrNull = calcShippingComponentHuf({
			shippingType: processConfig?.shippingType || 'fixed',
			shippingValue: processConfig?.shippingValue || 0,
			weight,
		});

		if (requiresWeight) {
			const wf = processConfig?.weightFields || {};
			if (shippingAmountOrNull == null) {
				const msg = `[súly] Súly alapú szállítást állítottál be, de nincs súly adat (feed="${
					wf.feed || ''
				}", unas="${wf.unas || ''}").`;
				stats.failed.push({
					key: feedKey,
					sku: unasSku,
					unasKey,
					reason: 'Hiányzó súly adat',
					message: msg,
					error: msg,
				});
				console.warn('[UNAS][WEIGHT][MISSING]', {
					sku: unasSku,
					feedKey: processConfig?.weightFields?.feed,
					feedVal: processConfig?.weightFields?.feed
						? rec[processConfig.weightFields.feed]
						: undefined,
					unasKey: processConfig?.weightFields?.unas,
					unasVal: processConfig?.weightFields?.unas
						? entry[processConfig.weightFields.unas]
						: undefined,
				});
				continue;
			}
		}
		const shippingAmount = includesShipping ? (shippingAmountOrNull || 0) : 0;


		// 4) Ár logika
		let priceValue = null;
		let priceField = processConfig?.priceFields?.feed;

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
				error: `[ár] ${msg}`,
			});
			continue;
		}

		// 5) Deviza + konverzió
		const currency = (processConfig?.currency || 'HUF').toUpperCase();
		let priceHuf = priceValue;
		if (currency !== 'HUF') {
			priceHuf = await convertCurrency(priceValue, currency, 'HUF');
		}

		const vatPct = Number(processConfig?.vat ?? 27);
		const vatFactor = 1 + (isFinite(vatPct) ? vatPct : 0) / 100;
		const vatPercent = Number.isFinite(vatPct) ? vatPct : 0;

		const marginPct = Number(processConfig?.priceMargin ?? 0);
		const marginPercent = Number.isFinite(marginPct) ? marginPct : 0;
		let marginMultiplier = Number.isFinite(marginPct) ? marginPercent / 100 : 0;
		if (!Number.isFinite(marginMultiplier)) marginMultiplier = 0;
		if (marginMultiplier < 0) marginMultiplier = 0;
		const marginFactor = 1 + marginMultiplier;

		const discountPct = Number(processConfig?.discount ?? 0);
		const discountPercent = Number.isFinite(discountPct) ? discountPct : 0;
		let discountMultiplier = Number.isFinite(discountPct)
			? 1 - discountPercent / 100
			: 1;
		if (!Number.isFinite(discountMultiplier)) discountMultiplier = 1;
		if (discountMultiplier < 0) discountMultiplier = 0;

		const formulaRaw = processConfig?.pricingFormula || '';
		let formulaAmount = null;
		let formulaUsed = false;

		if (formulaRaw.trim()) {
			const evalContext = {
				basePrice: priceHuf,
				shipping: shippingAmount,
				priceMargin: marginFactor,
				priceMarginPercent: marginPercent,
				priceMarginFactor: marginFactor,
				discount: discountMultiplier,
				discountPercent,
				discountMultiplier,
				vat: vatFactor,
				vatPercent,
			};
			const computed = evaluatePricingFormula(formulaRaw, evalContext);
			if (!Number.isFinite(computed)) {
				const msg =
					'[UNAS][ERROR] Invalid pricingFormula result (sku: ' +
					(rec.sku || rec['Cikkszám'] || '') +
					', formula: ' +
					formulaRaw +
					')';
				console.error(msg);
				stats.failed.push({
					key: feedKey,
					sku: unasSku,
					unasKey,
					reason: 'Invalid pricingFormula',
					message: msg,
					error: '[price] ' + msg,
				});
				continue;
			}
			formulaAmount = Math.max(0, computed);
			formulaUsed = true;
		}

		const itemForEnsure = formulaUsed
			? { price_gross: formulaAmount }
			: includesVat
				? { price_gross: priceHuf + shippingAmount }
				: { price_net: priceHuf + shippingAmount };

		const netGross = await ensureNetGross(itemForEnsure, {
			...processConfig,
			currency: 'HUF',
		});

		let net = netGross.net;
		let gross = netGross.gross;

		const round4 = (x) => Math.round(x * 10000) / 10000;

		if (processConfig?.rounding && processConfig.rounding > 0) {
			const factor = Math.max(1, Number(processConfig.rounding) || 0);
			const grossRounded = Math.ceil(gross / factor) * factor; // lépcsőre kerekített bruttó (egész)
			gross = grossRounded;
			net = round4(gross / vatFactor); // nettó 4 tizedes
		} else {
			// bruttó marad egészre kerekítve, nettó 4 tizedes a bruttóból
			gross = Math.round(gross);
			net = round4(gross / vatFactor);
		}

		console.log('[UNAS][DEBUG][calc]', {
			sku: unasSku,
			priceSrc: {
				field: priceField,
				value: rec[priceField],
				parsed: priceValue,
				currency,
				baseHuf: priceHuf,
				formula: formulaUsed
					? {
						raw: formulaRaw,
						result: formulaAmount,
						values: {
							basePrice: priceHuf,
							shipping: shippingAmount,
							priceMargin: marginMultiplier,
							priceMarginPercent: marginPercent,
							priceMarginFactor: marginFactor,
							discount: discountMultiplier,
							discountPercent,
							discountMultiplier,
							vat: vatFactor,
							vatPercent,
						},
					}
					: null,
			},
			weightSrc: {
				feedKey: processConfig?.weightFields?.feed,
				feedVal: processConfig?.weightFields?.feed
					? rec[processConfig.weightFields.feed]
					: undefined,
				unasKey: processConfig?.weightFields?.unas,
				unasVal: processConfig?.weightFields?.unas
					? entry[processConfig.weightFields.unas]
					: undefined,
				parsed: weight,
			},
			shipping: {
				type: processConfig?.shippingType,
				value: processConfig?.shippingValue,
				amount: shippingAmount,
				includesShipping,
				amountApplied: shippingAmount,
			},
			preRound: { net: netGross.net, gross: netGross.gross },
			postRound: { net, gross },
		});

		// 7) Orderable (bemeno rekordból átvéve)
		let orderable = rec.orderable;
		// console.log('[UNAS][DEBUG][orderable calc]', {
		// 	sku: rec.sku || rec['Cikkszám'] || '',
		// 	orderable: orderable,
		// });

		const after = {
			...rec, // minden mező eredeti formában
			price_net: net,
			price_gross: gross,
			currency: currency,
			orderable: orderable,
			_calc: {
				weight,
				shippingAmount,
				priceHuf,
				formulaUsed,
				formulaAmount,
				marginPercent,
				marginMultiplier,
				marginFactor,
				discountPercent,
				discountMultiplier,
				vatPercent,
			},
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
			const fetched = await fetchProductBySku(bearer, unasSku, {
				paramIds: contentParamIds,
			});
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
			// console.log('[UNAS][DEBUG][orderable unasIndex]', {
			// 	sku: unasSku,
			// 	unasOrderable: orderableValue,
			// 	unasEntry,
			// });
		}

		// 9) XML payload felépítése
		const productNode = { Sku: unasSku };
		if (rec.name != null) productNode.Name = String(rec.name);

		// orderable → csak a státuszt küldjük
		if (after.orderable !== undefined && after.orderable !== '') {
			productNode.Stocks = {
				Status: {
					Active: '1',
					Empty: String(after.orderable),
				},
			};
		}

		productNode.Prices = {
			Price: {
				Type: 'normal',
				Net: toPosNumberString(net, 4),
				Gross: toPosNumberString(gross),
				Currency: currency,
				Actual: '1',
			},
		};

		// 10) Diff és "nincs változás" kezelése → számláló
		const afterComparable = {
			price_net: net,
			price_gross: gross,
		};
		if (productNode.Stocks) {
			afterComparable.orderable = after.orderable;
		}

		const changes = diffFields(before || {}, afterComparable);
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
					error: `[UNAS] setProduct ${resp.status} ${resp.statusText}`,
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
				error: `[UNAS] ${String(err?.message || err)}`,
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

