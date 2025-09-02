// backend/src/api/unasFields.js
require('../bootstrapEnv');
const axios = require('axios');
const { parse: csvParse } = require('csv-parse/sync');
const { getBearerTokenForShop } = require('./unasAuth');
const { db } = require('../db/firestore');

const RAW_BASE = (process.env.UNAS_API_URL || 'https://api.unas.eu/shop').replace(/\/+$/, '');
const BASE_URL = RAW_BASE.replace(/\/shop\/[^/]+$/i, '/shop');

// Egyszerű in-memory cache (per UNAS shopId)
const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 óra

function putCache(key, value) {
  CACHE.set(key, { value, ts: Date.now() });
}
function getCache(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

// Fejléc → {key,label}
function headersToFieldsRaw(headers) {
  return (headers || []).map(h => ({ key: String(h), label: String(h) }));
}

async function fetchUnasFieldsFromFirestore(shopDocId) {
  if (!shopDocId) throw new Error('shopDocId kötelező');

  // 0) Shop Firestore-ból
  const snap = await db.collection('shops').doc(String(shopDocId)).get();
  if (!snap.exists) throw new Error(`Shop not found: ${shopDocId}`);
  const shop = snap.data() || {};

  const unasShopId = String(shop.unasShopId || '').trim();
  const apiKey = String(shop.apiKey || '').trim();
  if (!unasShopId) throw new Error(`Missing unasShopId in Firestore for doc: ${snap.id}`);
  if (!apiKey) throw new Error(`Missing apiKey for shop doc: ${snap.id}`);

  console.log('[UNAS DIAG] /unas/fields start', {
    shopDocId,
    unasShopId,
    base: BASE_URL
  });

  // 1) Cache
  const cacheKey = `unasFields:${unasShopId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // 2) Token
  let bearer;
  try {
    bearer = await getBearerTokenForShop(unasShopId, apiKey);
  } catch (e) {
    // Itt szokott kijönni az "invalid ApiKey" → most explicit kontextussal dobjuk tovább
    throw new Error(`UNAS login failed for unasShopId="${unasShopId}" (doc="${shopDocId}"): ${String(e?.message || e)}`);
  }

  // 3) getProductDB generálás: GET → ha nem 200, POST + <GetProductDB/>
  const genUrl = `${BASE_URL}/${unasShopId}/getProductDB`;
  let genResp = await axios.get(genUrl, {
    headers: { Authorization: `Bearer ${bearer}` },
    responseType: 'text',
    timeout: Number(process.env.UNAS_TIMEOUT_MS ?? 120000),
    validateStatus: s => s >= 200 && s < 500,
  });

  if (genResp.status !== 200) {
    const requestXml = `<?xml version="1.0" encoding="UTF-8"?><GetProductDB/>`;
    genResp = await axios.post(genUrl, requestXml, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'text/xml; charset=UTF-8',
      },
      responseType: 'text',
      timeout: Number(process.env.UNAS_TIMEOUT_MS ?? 120000),
      validateStatus: s => s >= 200 && s < 500,
    });
  }

  if (genResp.status !== 200) {
    const body = String(genResp.data || '').slice(0, 500);
    throw new Error(`unas_getProductDB_gen_failed HTTP ${genResp.status} (GET->POST fallback után is): ${body}`);
  }

  // 4) XML → letöltési link
  const link = (() => {
    const txt = String(genResp.data || '');
    const m1 = txt.match(/<Link>([^<]+)<\/Link>/i);
    if (m1) return m1[1];
    const m2 = txt.match(/<Url>([^<]+)<\/Url>/i);
    if (m2) return m2[1];
    return null;
  })();
  if (!link) throw new Error('getProductDB response: hiányzik a letöltési link (Link/Url).');

  // 5) CSV letöltése a kapott linkről
  const csvResp = await axios.get(link, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.UNAS_DOWNLOAD_TIMEOUT_MS ?? 120000),
    validateStatus: s => s >= 200 && s < 500,
  });
  if (csvResp.status !== 200) {
    const body = Buffer.from(csvResp.data || '').toString('utf8').slice(0, 500);
    throw new Error(`unas_getProductDB_download_failed HTTP ${csvResp.status}: ${body}`);
  }

  // 6) CSV → fejléc
  let csvText = Buffer.from(csvResp.data).toString('utf8');
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

  const rows = csvParse(csvText, { delimiter: ';', relax_column_count: true, skip_empty_lines: true });
  if (!rows?.length) return { shopId: shopDocId, unasShopId, count: 0, fields: [] };

  const fields = headersToFieldsRaw(rows[0]);
  const payload = { shopId: shopDocId, unasShopId, count: fields.length, fields };
  putCache(cacheKey, payload);
  console.log('[UNAS DIAG] /unas/fields OK', { shopDocId, unasShopId, fieldCount: fields.length });
  return payload;
}

module.exports = { fetchUnasFieldsFromFirestore };
