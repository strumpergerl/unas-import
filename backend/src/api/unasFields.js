// backend/src/api/unasFields.js
require('../bootstrapEnv');
const axios = require('axios');
const { parse: csvParse } = require('csv-parse/sync');
const { getBearerTokenForShop } = require('./unasAuth');
const { loadShopById } = require('./loadShops');

const BASE_URL = process.env.UNAS_API_URL;

// Egyszerű in-memory cache (per shopId)
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

function normalizeHeader(h) {
  return String(h || '').trim();
}

/**
 * A csv2 (pontosvessző) fejlécből összeállítja a mezők listáját.
 * Visszaad: [{key, label, group}]
 */
function headersToFields(headers) {
  const fields = [];
  const add = (key, label, group='Alap mezők') => fields.push({ key, label, group });

  // Alap mezők – próbáljuk felismerni a tipikus magyar feliratokat
  const H = new Set(headers.map(normalizeHeader));
  if (H.has('Cikkszám')) add('sku', 'sku (Cikkszám)');
  if (H.has('Nettó Ár')) add('price.net', 'Nettó ár');
  if (H.has('Bruttó Ár')) add('price.gross', 'Bruttó ár');
  if (H.has('Raktárkészlet')) add('stock', 'Készlet (Raktárkészlet)');

  // Általános mezők, ha a feed tartalmazza (néhány gyakori példa)
  if (H.has('Megnevezés')) add('name', 'Név (Megnevezés)');
  if (H.has('Állapot')) add('state', 'Állapot');
  if (H.has('Kategória')) add('category', 'Kategória');

  // Paraméterek („Paraméter: …” kezdetű oszlopok)
  headers.forEach((h) => {
    const label = normalizeHeader(h);
    if (label.startsWith('Paraméter:')) {
      // pl.: "Paraméter: Beszerzési helyen a cikkszáma - Csak nekünk|Alap paraméterek (kötelező)|text|0|..."
      // A látható cím az első " - " vagy "|" előtti rész.
      const visible = label
        .replace(/^Paraméter:\s*/,'')
        .split('|')[0]
        .split(' - ')[0]
        .trim();
      fields.push({
        key: `param:${visible}`,
        label: `Paraméter • ${visible}`,
        group: 'Paraméterek'
      });
    }
  });

  // Biztonsági fix mezők (ha nincs a fejlécben, akkor is legyen opció)
  const ensure = (key, label) => {
    if (!fields.some(f => f.key === key)) fields.push({ key, label, group: 'Alap mezők' });
  };
  ensure('sku', 'sku');
  ensure('price.gross', 'Bruttó ár');
  ensure('stock', 'Készlet');

  return fields;
}

async function fetchUnasFields(shopId) {
  const cacheKey = `unasFields:${shopId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const shop = loadShopById(shopId);
  const bearer = await getBearerTokenForShop(shop.shopId, shop.apiKey);

  // getProductDB – csv2 (pontosvesszős), csak a fejléc kell
  const url = `${BASE_URL}/${shopId}/getProductDB`;
  const res = await axios.get(url, {
    params: { format: 'csv2' },
    headers: { Authorization: `Bearer ${bearer}` },
    responseType: 'arraybuffer',
    timeout: Number(process.env.UNAS_DOWNLOAD_TIMEOUT_MS ?? 120000)
  });

  // A fájl első sora a fejléc; a csv-parse könnyen kiszedi
  const csvText = Buffer.from(res.data).toString('utf8');
  const rows = csvParse(csvText, { delimiter: ';', relax_column_count: true });
  if (!rows || !rows.length) throw new Error('Üres ProductDB export');

  const header = rows[0];
  const fields = headersToFields(header);
  putCache(cacheKey, fields);
  return fields;
}

// Express router példa
module.exports = function unasFieldsRouter(app) {
  app.get('/api/unas/fields', async (req, res) => {
    try {
      const { shopId } = req.query;
      if (!shopId) return res.status(400).json({ error: 'shopId szükséges' });
      const fields = await fetchUnasFields(shopId);
      res.json({ shopId, count: fields.length, fields });
    } catch (e) {
      console.error('[UNAS] fields error:', e.message);
      // Minimális fallback lista, ha bármi gond van
      res.json({
        shopId: req.query.shopId,
        count: 3,
        fields: [
          { key: 'sku', label: 'sku', group: 'Alap mezők' },
          { key: 'price.gross', label: 'Bruttó ár', group: 'Alap mezők' },
          { key: 'stock', label: 'Készlet', group: 'Alap mezők' },
        ]
      });
    }
  });
};
