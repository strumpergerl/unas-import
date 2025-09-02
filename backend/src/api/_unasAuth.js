// backend/src/api/unasAuth.js
const axios = require('axios');
const xml2js = require('xml2js');

const RAW_BASE = (process.env.UNAS_API_URL || 'https://api.unas.eu/shop').replace(/\/+$/, '');
const BASE = RAW_BASE.replace(/\/shop\/[^/]+$/i, '/shop');
const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

// Egyszerű in-memory cache: kulcs = shopId::apiKey
const tokenCache = new Map();

// UNAS "2025.08.31 21:36:17" → Date
function parseUnasExpire(expireText) {
  if (!expireText || typeof expireText !== 'string') return null;
  const m = expireText.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Lokális időzónát használunk – ez bőven elég cache validálásra
  return new Date(y, mo - 1, d, h, mi, s);
}

/**
 * Login UNAS-hoz az apiKey-vel. Visszaad { token, expire }-t.
 */
async function unasLogin(apiKey, includeWebshopInfo = true) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('UNAS login: empty ApiKey');

  console.log('[UNAS DIAG] login → BASE:', BASE, ' key_len:', key.length);

  const xmlObj = { Login: { ApiKey: key, WebshopInfo: includeWebshopInfo ? 'true' : 'false' } };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject(xmlObj)}`;

  const resp = await axios.post(`${BASE}/login`, xml, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const raw = resp.data;
    throw new Error(
      `UNAS login failed (${resp.status} ${resp.statusText}): ${
        typeof raw === 'string' ? raw : JSON.stringify(raw)
      }`
    );
  }

  const parsed = await parser.parseStringPromise(resp.data);
  const token =
    parsed?.LoginResponse?.Token || parsed?.token || parsed?.Login?.Token;
  const expireText =
    parsed?.LoginResponse?.Expire || parsed?.expire || parsed?.Login?.Expire;

  if (!token) throw new Error('UNAS login: Token missing in response');

  let expire = parseUnasExpire(expireText);
  if (!(expire instanceof Date) || isNaN(expire)) {
    // Ha nem értelmezhető, legyen 20 perc
    expire = new Date(Date.now() + 1000 * 60 * 20);
  }
  return { token, expire };
}

/**
 * Shop szintű token lekérő cache-eléssel.
 */
async function getBearerTokenForShop(shopId, apiKey) {
  const now = new Date();
  const key = String(apiKey || '').trim();
  const cacheKey = `${shopId}::${key}`;
  const cached = tokenCache.get(cacheKey);

  if (
    cached &&
    cached.token &&
    cached.expire instanceof Date &&
    !isNaN(cached.expire) &&
    cached.expire > new Date(now.getTime() + 60 * 1000)
  ) {
    return cached.token;
  }
  const { token, expire } = await unasLogin(key, false);
  tokenCache.set(cacheKey, { token, expire });
  return token;
}

module.exports = { getBearerTokenForShop };
