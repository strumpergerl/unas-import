// backend/src/api/loadShops.js
const fs = require('fs');
const path = require('path');

function resolveEnvPlaceholder(value) {
  if (typeof value !== 'string') return { value, varName: null };
  const m = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (!m) return { value, varName: null };
  const varName = m[1];
  const resolved = process.env[varName] || '';
  return { value: resolved, varName };
}

function loadShopById(shopId) {
  const file = path.join(__dirname, '../config/shops.json');
  const raw = fs.readFileSync(file, 'utf8');
  const shops = JSON.parse(raw);

  const shop = shops.find(s => s.shopId === shopId);
  if (!shop) throw new Error(`Shop not found: ${shopId}`);

  const { value: apiKey, varName } = resolveEnvPlaceholder(shop.apiKey);

  if (!apiKey) {
    const hint = varName
      ? `Hiányzik az env változó: ${varName}. Ellenőrizd, hogy a .env betöltődött-e és a kulcs pontosan így szerepel-e.`
      : `Az apiKey üres. Ha placeholdert akarsz használni, add meg így: "\${SHOP3_API_KEY}" és tedd a .env-be a változót.`;
    throw new Error(`shops.json/.env: üres apiKey a(z) ${shopId} bejegyzésnél. ${hint}`);
  }

  return { ...shop, apiKey };
}

module.exports = { loadShopById };
