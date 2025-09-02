// backend/src/api/loadShops.js
const { db } = require('../db/firestore');

function resolveEnvPlaceholder(value) {
  if (typeof value !== 'string') return { value, varName: null };
  const m = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (!m) return { value, varName: null };
  const varName = m[1];
  const resolved = process.env[varName] || '';
  return { value: resolved, varName };
}

async function loadShopById(shopId) {
  const doc = await db.collection('shops').doc(String(shopId)).get();
  if (!doc.exists) throw new Error(`Shop not found: ${shopId}`);
  const shop = { shopId, ...doc.data() };

  const { value: apiKey, varName } = resolveEnvPlaceholder(shop.apiKey);
  if (!apiKey) {
    const hint = varName
      ? `Hiányzik az env változó: ${varName}. Ellenőrizd a környezetet.`
      : `Az apiKey üres. Használhatsz "\${SHOP3_API_KEY}" formát is .env-ből.`;
    throw new Error(`shops/.env: üres apiKey a(z) ${shopId} bejegyzésnél. ${hint}`);
  }

  return { ...shop, apiKey };
}

module.exports = { loadShopById };