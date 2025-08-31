// backend/src/core/uploadToUnas.js
require('../bootstrapEnv');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const http = require('http');
const https = require('https');
const { getBearerTokenForShop } = require('../api/unasAuth');
const { loadShopById } = require('../api/loadShops');
const { parse: csvParse } = require('csv-parse/sync');

// --- Beállítások ENV-ből (jó defaultokkal)
const BASE_URL = process.env.UNAS_API_URL;
const UNAS_TIMEOUT_MS = Number(process.env.UNAS_TIMEOUT_MS ?? 120000);
const UNAS_DOWNLOAD_TIMEOUT_MS = Number(process.env.UNAS_DOWNLOAD_TIMEOUT_MS ?? 120000);
const UNAS_PRODUCTDB_MAX_RETRIES = Number(process.env.UNAS_PRODUCTDB_MAX_RETRIES ?? 3);
const UNAS_PRODUCTDB_BACKOFF_MS = Number(process.env.UNAS_PRODUCTDB_BACKOFF_MS ?? 3000);
const UNAS_INDEX_TTL_HOURS = Number(process.env.UNAS_INDEX_TTL_HOURS ?? 24);

const CACHE_DIR = path.join(process.cwd(), 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 20 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 20 });

function toPosNumberString(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return Math.max(0, n).toString();
}

function formulaHasVat(formula) {
  return typeof formula === 'string' && /\{vat\}/i.test(formula);
}

function ensureNetGross(item, processConfig) {
  const vatPct = Number(processConfig?.vat ?? 0);
  const vatFactor = 1 + (isFinite(vatPct) ? vatPct : 0) / 100;

  // A transformData által előállított mezők (preferált)
  const inNet   = item.price_net   != null ? Number(item.price_net)   : null;
  const inGross = item.price_gross != null ? Number(item.price_gross) : null;

  // Legacy: csak "price" érkezett a rekordban
  const legacy  = item.price != null ? Number(item.price) : null;

  const treatLegacyAsGross = formulaHasVat(processConfig?.pricingFormula);

  let net = null;
  let gross = null;

  if (Number.isFinite(inNet) && inNet > 0 && Number.isFinite(inGross) && inGross > 0) {
    net = inNet;
    gross = inGross;
  } else if (Number.isFinite(inNet) && inNet > 0) {
    net = inNet;
    gross = inNet * vatFactor;
  } else if (Number.isFinite(inGross) && inGross > 0) {
    gross = inGross;
    net = vatFactor > 0 ? inGross / vatFactor : inGross;
  } else if (Number.isFinite(legacy) && legacy > 0) {
    // Itt dől el, hogy a legacy "price" nettó vagy bruttó
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

  //  Egész Ft-ra kerekítés
  net   = Math.floor(Math.max(0, net));
  gross = Math.floor(Math.max(0, gross));

  return { net, gross };
}

// --- Header címke normalizálás
function normalizeUnasHeaderLabel(h) {
  const s = String(h ?? '').trim();
  // Ha tartalmaz '|', csak az első '|' előtti rész számít címkének
  const beforePipe = s.includes('|') ? s.split('|', 1)[0] : s;
  // Eltávolítjuk a "Paraméter:" előtagot (kis/nagybetűtől függetlenül)
  return beforePipe.replace(/^paraméter\s*:\s*/i, '').trim();
}


const EXPLICIT_SUPPLIER_CODE_HEADER = process.env.UNAS_SUPPLIER_CODE_HEADER || null;

const SUPPLIER_CODE_HEADER_CANDIDATES = [
  /beszállítói.*cikkszám/i,
  /beszállítói.*kód/i,
  /beszerzési.*cikkszám/i,
  /supplier.*(code|sku)/i,
  /gyártói.*cikkszám/i,
  /part\s*number/i,
  /\bmpn\b/i,
];

// KONKRÉT név, amit most kaptál a ProductDB-ből:
const CANONICAL_SUPPLIER_PARAM_NAME = 'Beszerzési helyen a cikkszáma - Csak nekünk';

const norm = s => String(s ?? '').trim();

function findSupplierCodeColumn(headerArr, processConfig) {
  // 0) Normalizált névlista (Paraméter:...|... formátum levágva)
  const normalized = headerArr.map(h => ({
    raw: h,
    norm: normalizeUnasHeaderLabel(h)
  }));

  // 1) processConfig / ENV explicit egyezés (ha egyszer bevezeted a processConfig átadást)
  const explicitName = processConfig?.supplierCodeHeader || EXPLICIT_SUPPLIER_CODE_HEADER;
  if (explicitName) {
    const hit = normalized.find(({ norm }) => norm.toLowerCase() === String(explicitName).trim().toLowerCase());
    if (hit) return hit.raw;
  }

  // 2) Param ID minták (#86891), ha esetleg külön így jönne (meghagyjuk a korábbi logikát is)
  const byParamId =
    headerArr.find(h => /^param[_\s-]*86891$/i.test(String(h).trim())) ||
    headerArr.find(h => /^parameter[_\s-]*86891$/i.test(String(h).trim())) ||
    headerArr.find(h => /\(#?\s*86891\)/i.test(String(h))) ||
    headerArr.find(h => /\b86891\b/.test(String(h))) ||
    headerArr.find(h => String(h).trim() === 'Beszerzési helyen a cikkszáma - Csak nekünk');
  if (byParamId) return byParamId;

  // 3) KONKRÉT megnevezés a normalizált névben (ez a te eseted):
  const exact = normalized.find(({ norm }) => norm === CANONICAL_SUPPLIER_PARAM_NAME);
  if (exact) return exact.raw;

  // 4) Általános heurisztikák a normalizált névre
  for (const rx of SUPPLIER_CODE_HEADER_CANDIDATES) {
    const found = normalized.find(({ norm }) => rx.test(norm));
    if (found) return found.raw;
  }

  return undefined;
}

// --- Helper: backoff
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function migrateIndexShape(idx) {
  // Régi: supplierCode -> "UNAS_SKU" (string)
  // Új:  supplierCode -> { sku, cikkszam, netto, brutto }
  let mutated = false;
  for (const [key, val] of idx.entries()) {
    if (typeof val === 'string') {
      idx.set(key, { sku: val, cikkszam: '', netto: '', brutto: '' });
      mutated = true;
    } else if (val && typeof val === 'object') {
      // gondoskodjunk a mezőkről
      idx.set(key, {
        sku: val.sku || '',
        cikkszam: val.cikkszam || '',
        netto: val.netto || '',
        brutto: val.brutto || '',
      });
    } else {
      idx.delete(key);
      mutated = true;
    }
  }
  return mutated;
}

// --- Diszk cache utilok
function indexCacheFile(shopId) {
  return path.join(CACHE_DIR, `productDbIndex.${shopId}.json`);
}
function loadIndexFromDisk(shopId) {
  const file = indexCacheFile(shopId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const ageMs = Date.now() - new Date(data.updatedAt).getTime();
    const ttlMs = UNAS_INDEX_TTL_HOURS * 60 * 60 * 1000;
    if (ageMs > ttlMs) return null; // lejárt
    return new Map(Object.entries(data.pairs || {}));
  } catch {
    return null;
  }
}
function saveIndexToDisk(shopId, idx) {
  const file = indexCacheFile(shopId);
  const obj = Object.fromEntries(idx.entries());
  const payload = { updatedAt: new Date().toISOString(), pairs: obj };
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
}

// --- UNAS XML POST
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

// --- Param (#86891) kigyűjtése termék/variáns nódusból
function addMatchesFromParamNode(idx, sku, paramNode) {
  if (!sku) return;
  const params = Array.isArray(paramNode) ? paramNode : (paramNode ? [paramNode] : []);
  for (const p of params) {
    const id = String(p?.Id ?? p?.ID ?? '').trim();
    const name = String(p?.Name ?? '').trim();
    const value = String(p?.Value ?? p?._ ?? '').trim();
    if (!value) continue;

    // Cél: Param #86891 vagy név alapján beszállítói cikkszám mező
    const isTargetId = id === '86891';
    const looksLike = /beszerzési.*cikkszám|supplier.*(code|sku)|cikkszáma/i.test(name);

    if (isTargetId || looksLike) {
      if (!idx.has(value)) idx.set(value, sku);
    }
  }
}

/* --------- ProductDB index (Param#86891 → UNAS Sku) --------- */
// per‑shop memória cache: shopId -> Map(supplierCode -> unasSku)
let productDbIndexCache = new Map();

function ensureIndexInMemory(shopId) {
  if (!productDbIndexCache.has(shopId)) {
    const disk = loadIndexFromDisk(shopId);
    if (disk) {
      // MIGRÁCIÓ
      const changed = migrateIndexShape(disk);
      productDbIndexCache.set(shopId, disk);
      if (changed) {
        console.log(`[UNAS] Disk cache formátum migrálva (${shopId}), mentés...`);
        saveIndexToDisk(shopId, disk);
      } else {
        console.log(`[UNAS] Disk cache betöltve (${shopId}): ${disk.size} kulcs`);
      }
    }
  }
}

async function buildSupplierCodeToUnasSkuIndex(bearer, shopId) {
  // 0) Memória/diszk cache
  ensureIndexInMemory(shopId);
  if (productDbIndexCache.has(shopId)) {
    return productDbIndexCache.get(shopId);
  }

  // 1) ProductDB próbálkozás retry/backoff-fal
  try {
    const idx = await tryBuildIndexFromProductDBWithRetry(bearer);
    if (idx && idx.size > 0) {
      productDbIndexCache.set(shopId, idx);
      saveIndexToDisk(shopId, idx);
      console.log(`[UNAS] ProductDB index építve (${shopId}): ${idx.size} kulcs (Param#86891 → {sku,cikkszam,netto,brutto})`);

      return productDbIndexCache.get(shopId);
    }
  } catch (e) {
    console.warn('[UNAS] ProductDB index nem épült (megy fallback crawl-ra):', e?.message || e);
  }

  // 2) Fallback: crawl getProduct (lapozva)
  const idx = await buildIndexByCrawling(bearer);
  productDbIndexCache.set(shopId, idx);
  saveIndexToDisk(shopId, idx);
  console.log(`[UNAS] Crawl index építve (${shopId}): ${idx.size} kulcs (Param#86891 → Sku)`);
  return productDbIndexCache.get(shopId);
}

// --- ProductDB retry/backoff wrapper
async function tryBuildIndexFromProductDBWithRetry(bearer) {
  let lastErr;
  for (let attempt = 1; attempt <= UNAS_PRODUCTDB_MAX_RETRIES; attempt++) {
    try {
      return await tryBuildIndexFromProductDB(bearer);
    } catch (e) {
      lastErr = e;
      const isLast = attempt === UNAS_PRODUCTDB_MAX_RETRIES;
      const delay = UNAS_PRODUCTDB_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(
        `[UNAS] getProductDB próbálkozás ${attempt}/${UNAS_PRODUCTDB_MAX_RETRIES} hiba: ${e?.message || e}${
          isLast ? '' : ` – újrapróbálkozás ${delay}ms múlva`
        }`
      );
      if (!isLast) await sleep(delay);
    }
  }
  throw lastErr;
}

// --- ProductDB minimál kéréssel (csv2; param/price/stock)
async function tryBuildIndexFromProductDB(bearer) {
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
    console.error('[UNAS] getProductDB válasz törzs:', genResp.data);
    throw new Error(`[UNAS] getProductDB hiba: ${genResp.status} ${genResp.statusText}`);
  }

  const parsed = await parser.parseStringPromise(genResp.data);
  const downloadUrl = parsed?.getProductDB?.Url || parsed?.ProductDB?.Url || parsed?.Url || null;
  if (!downloadUrl) throw new Error('[UNAS] getProductDB: hiányzó letöltési URL');

  const fileResp = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    validateStatus: () => true,
    timeout: UNAS_DOWNLOAD_TIMEOUT_MS,
  });
  if (fileResp.status < 200 || fileResp.status >= 300) {
    throw new Error(`[UNAS] getProductDB fájl letöltési hiba: ${fileResp.status} ${fileResp.statusText}`);
  }

  let text = Buffer.from(fileResp.data).toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = csvParse(text, { columns: true, skip_empty_lines: true, delimiter: ';' });
  const header = rows[0] ? Object.keys(rows[0]) : [];

  // UNAS belső Sku oszlop
  const skuCol =
    header.find((h) => /^sku$/i.test(String(h).trim())) ||
    header.find((h) => /cikksz|cikkszám/i.test(String(h))); // biztonsági fallback

  // Beszállítói kód oszlop (Param#86891 vagy megnevezés alapján)
  const paramCol = findSupplierCodeColumn(header, null);

  // Cél oszlopok (rugalmas, ékezetekkel)
  const cikkszamCol = header.find((h) => /^cikkszám$/i.test(h));
  const nettoCol    = header.find((h) => /^nettó\s*ár$/i.test(h));
  const bruttoCol   = header.find((h) => /^bruttó\s*ár$/i.test(h));

  if (!skuCol || !paramCol) {
    console.warn(
      '[UNAS] ProductDB: nem találtam a szükséges oszlopokat.',
      { skuCol, paramCol, header }
    );
    return new Map(); // nincs értelmes index
  }

  if (!cikkszamCol || !nettoCol || !bruttoCol) {
    console.warn(
      '[UNAS] Figyelem: hiányzik egy vagy több cél oszlop (Cikkszám/Nettó Ár/Bruttó Ár). ' +
      'Az index akkor is épül, de a hiányzó mezők üresen maradnak.',
      {
        cikkszamCol: !!cikkszamCol,
        nettoCol: !!nettoCol,
        bruttoCol: !!bruttoCol,
      }
    );
  }

  const idx = new Map();
  for (const r of rows) {
    const unasSku      = String(r[skuCol] ?? '').trim();
    const supplierCode = norm(r[paramCol]);
    if (supplierCode && unasSku) {
      idx.set(supplierCode, {
        sku: unasSku,
        cikkszam: cikkszamCol ? String(r[cikkszamCol] ?? '').trim() : '',
        netto:    nettoCol    ? String(r[nettoCol] ?? '').trim()    : '',
        brutto:   bruttoCol   ? String(r[bruttoCol] ?? '').trim()   : '',
      });
    }
  }
  return idx;
}

// --- Fallback crawl: getProduct lapozva, Param gyűjtése
async function buildIndexByCrawling(bearer) {
  const idx = new Map();
  const limit = 500;
  let start = 0;

  for (;;) {
    const req = builder.buildObject({
      Params: {
        StatusBase: 1, // aktív termékek
        LimitNum: String(limit),
        LimitStart: String(start),
        ContentType: 'full', // Params/Variants is jön
      },
    });

    const resp = await postXml('getProduct', req, bearer);
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`[UNAS] getProduct crawl hiba: ${resp.status} ${resp.statusText}`);
    }

    const parsed = await parser.parseStringPromise(resp.data);

    let products = parsed?.Products?.Product || parsed?.ProductList?.Products?.Product || parsed?.Product || [];
    if (!Array.isArray(products)) products = products ? [products] : [];
    if (products.length === 0) break;

    for (const p of products) {
      const productSku = String(p?.Sku ?? '').trim();
      addMatchesFromParamNode(idx, productSku, p?.Params?.Param);

      const variants = p?.Variants?.Variant;
      const variantArr = Array.isArray(variants) ? variants : variants ? [variants] : [];
      for (const v of variantArr) {
        const variantSku = String(v?.Sku ?? v?.VariantSku ?? '').trim() || productSku;
        addMatchesFromParamNode(idx, variantSku, v?.Params?.Param);
      }
    }

    start += products.length;
    if (products.length < limit) break;
  }

  return idx;
}

/* --------- SKU létezés ellenőrzés --------- */
async function productExistsBySku(bearer, sku) {
  const payload = builder.buildObject({
    Params: { Sku: sku, ContentType: 'full', LimitNum: 1, StatusBase: 1 },
  });
  const resp = await postXml('getProduct', payload, bearer);
  if (resp.status < 200 || resp.status >= 300) return false;

  try {
    const parsed = await parser.parseStringPromise(resp.data);
    const product = parsed?.Products?.Product || parsed?.ProductList?.Products?.Product || parsed?.Product || null;
    return Boolean(product);
  } catch {
    return false;
  }
}

/* ---------------------- Fő feltöltő folyamat ---------------------- */
async function uploadToUnas(records, processConfig, shopConfig) {
  const { dryRun = false, shopId } = processConfig;

  const shop = shopConfig || loadShopById(shopId);
  const bearer = await getBearerTokenForShop(shop.shopId, shop.apiKey);

  // Statisztikák
  const stats = {
    shopId: shop.shopId,
    shopName: shop.name,
    total: records.length,
    modified: [],
    skippedNoSku: [],
    skippedNotFound: [],
    failed: [],
    dryRun: !!dryRun,
  };

  if (dryRun) {
    console.log(`DRY RUN: ${records.length} tétel menne fel a(z) ${shop.name} boltba (Action=modify)`);
    return stats;
  }

  // Egyszer építünk egy indexet: feed "SKU" (beszállítói kód) → UNAS belső Sku
  let supplierIndex;
  try {
    supplierIndex = await buildSupplierCodeToUnasSkuIndex(bearer, shop.shopId);
  } catch (e) {
    console.error('[UNAS] Nem sikerült a ProductDB indexet felépíteni:', e?.message || e);
    supplierIndex = new Map();
  }

  for (const rec of records) {
  // 1) Feed SKU = beszállítói kód (Param#86891 érték)
  const supplierCodeRaw = rec.sku || rec.SKU || rec.Sku;
  const supplierCode = norm(supplierCodeRaw); // <— legyen norm() a fájl tetején
  if (!supplierCode) {
    console.warn('[UNAS] Kihagyva: hiányzó supplierCode (feed SKU) a rekordban:', rec);
    stats.skippedNoSku.push(rec);
    continue;
  }

  // 2) Index lookup: supplierCode -> { sku, cikkszam, netto, brutto }
  const entry = supplierIndex.get(supplierCode);
  if (!entry || !entry.sku) {
    console.log(`[UNAS] Nincs UNAS Sku a supplierCode alapján (Param#86891): ${supplierCode}`);
    stats.skippedNotFound.push(supplierCode);
    continue;
  }

  const { sku, cikkszam, netto, brutto } = entry;

  // Debug kontextus – csak ha kell:
  console.debug('[UNAS] Kontextus:', { supplierCode, sku, cikkszam, netto, brutto });

  // 3) Létezés ellenőrzés
  let exists = false;
  try {
    exists = await productExistsBySku(bearer, sku);
  } catch (e) {
    console.warn(`[UNAS] Létezés-ellenőrzés hiba, SKU kihagyva: ${sku}`, e?.message || e);
    stats.skippedNotFound.push(sku);
    continue;
  }
  if (!exists) {
    console.log(`[UNAS] SKU nem található (kihagyva, csak modify engedett): ${sku}`);
    stats.skippedNotFound.push(sku);
    continue;
  }

  // 4) Product node összeállítás (nettó+bruttó ár mindig megy)
  const productNode = { Sku: sku };

  // Opcionális mezők
  if (rec.name != null) productNode.Name = String(rec.name);
  if (rec.description != null) productNode.Description = String(rec.description);

  // Készlet (ha van)
  if (rec.stock != null) {
    const qty = Math.max(0, Math.trunc(Number(rec.stock) || 0));
    // UNAS többféle készlet-sémát elfogad; a legkompatibilisebb a Stocks/Stock/Qty
    productNode.Stocks = { Stock: { Qty: String(qty) } };
  }

  // Nettó+bruttó biztosítása a processConfig.vat alapján (legacy price fallback-kal)
  const { net, gross } = ensureNetGross(rec, processConfig);
  const netStr = toPosNumberString(net);
  const grossStr = toPosNumberString(gross);

  // Mindig küldjük a normal ár sort Actual=1-gyel
  productNode.Prices = {
    Price: {
      Type: 'normal',
      Net: netStr,
      Gross: grossStr,
      Actual: '1',
    },
  };

  const payload = builder.buildObject({
    Products: { Product: { Action: 'modify', ...productNode } },
  });

  if (process.env.DEBUG_UNAS_XML === '1') {
    console.debug('[UNAS OUT XML]\n<?xml version="1.0" encoding="UTF-8"?>\n' + payload);
  }

  console.log(`→ [UNAS] setProduct (modify) SKU=${sku} (supplierCode=${supplierCode})`);
  try {
    const resp = await postXml('setProduct', payload, bearer);
    if (resp.status < 200 || resp.status >= 300) {
      console.error(`❌ [UNAS] setProduct hiba SKU=${sku}: ${resp.status} ${resp.statusText}`);
      stats.failed.push({
        sku,
        status: resp.status,
        statusText: resp.statusText,
        raw: resp.data,
      });
      continue;
    }
    console.log(`✓ [UNAS] módosítva SKU=${sku}`);
    stats.modified.push(sku);
  } catch (err) {
    console.error(`❌ [UNAS] setProduct kivétel SKU=${sku}:`, err?.message || err);
    stats.failed.push({
      sku,
      status: err?.response?.status || null,
      statusText: err?.response?.statusText || String(err?.message || err),
      raw: err?.response?.data || null,
    });
  }
}

  // Opcionális: futás végén friss cache mentés
  if (productDbIndexCache.has(shop.shopId)) {
    saveIndexToDisk(shop.shopId, productDbIndexCache.get(shop.shopId));
  }

  return stats;
}

module.exports = uploadToUnas;
