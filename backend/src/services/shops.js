// backend/src/services/shops.js
const { db } = require('../db/firestore');
const { BadRequestError, NotFoundError } = require('../shared/errors');

function resolveEnvPlaceholder(value) {
  if (typeof value !== 'string') return { value, varName: null };
  const m = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (!m) return { value, varName: null };
  const varName = m[1];
  const resolved = process.env[varName] || '';
  return { value: resolved, varName };
}

async function loadShopById(shopDocId) {
  if (!shopDocId) throw new BadRequestError('shopId szükséges');
  const snap = await db.collection('shops').doc(String(shopDocId)).get();
  if (!snap.exists) throw new NotFoundError(`Shop not found: ${shopDocId}`);

  const shop = { shopId: shopDocId, ...snap.data() };

  const { value: apiKey, varName } = resolveEnvPlaceholder(shop.apiKey);
  if (varName) {
    console.log('[SHOPS][DEBUG] env placeholder:', {
      shopId: shopDocId,
      envVar: varName,
      isSet: !!process.env[varName],
      isEmpty: !process.env[varName]
    });
  }
  if (!apiKey) {
    const hint = varName
      ? `Hiányzik az env változó: ${varName}.`
      : `Az apiKey üres. Használhatsz "\${SHOP3_API_KEY}" formát is .env-ből.`;
    throw new BadRequestError(`Üres apiKey a(z) ${shopDocId} bejegyzésnél. ${hint}`);
  }

  const unasShopId = String(shop.unasShopId || '').trim();

  return { ...shop, apiKey, unasShopId };
}

module.exports = { loadShopById };
