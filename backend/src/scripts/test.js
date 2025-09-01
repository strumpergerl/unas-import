// node backend/src/scripts/test.js <shopId>
require('../bootstrapEnv');
const { loadShopById } = require('../services/shops');
const { ensureUnasShopId, fetchProductDbHeaders } = require('../services/unas');
(async () => {
  try {
    const shopId = process.argv[2];
    if (!shopId) {
      console.error('Használat: node backend/src/tools/test.js <shopId>');
      process.exit(1);
    }

    const shop = await loadShopById(shopId);
    console.log('[TEST] Firestore shop:', { shopId, unasShopId: shop.unasShopId, apiKeyMasked: (shop.apiKey||'').slice(0,6)+'...' });

    const realShopId = await ensureUnasShopId(shop.apiKey, shop.unasShopId);
    console.log('[TEST] Felismert unasShopId:', realShopId);

    const { headers } = await fetchProductDbHeaders({ unasShopId: realShopId, apiKey: shop.apiKey });
    console.log('[TEST] OK! Fejlécek (max 30):', headers.slice(0,30));
  } catch (e) {
    console.error('[TEST] Hiba:', e.code || e.name, e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0,3).join('\n'));
    process.exit(2);
  }
})();