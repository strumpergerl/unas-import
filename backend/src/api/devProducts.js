// backend/src/api/devProducts.js
const express = require('express');
const shops = require('../config/shops.json');
const { createUnasClient } = require('../core/unasClient');

const router = express.Router();

/**
 * GET /api/dev/unas/products?shopId=...&sku=...&supplier=...&name=...&limit=...
 * (Az index.js /api alá mountolja a /dev-et.)
 */
router.get('/unas/products', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Ez a végpont csak fejlesztéshez engedélyezett.' });
  }
  try {
    const { shopId, sku, supplier, name } = req.query;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    if (!shopId) return res.status(400).json({ error: 'shopId kötelező.' });

    const shop = shops.find(s => s.shopId === shopId);
    if (!shop) return res.status(404).json({ error: 'Ismeretlen shopId.' });

    const unas = createUnasClient(shop);

    let items = [];
    if (sku && String(sku).trim()) {
      items = await unas.getProductBySku(String(sku).trim());
    } else {
      items = await unas.searchProducts({ name, supplier, limit });
    }

    const normalized = (items || []).map(p => ({
      sku: p.sku || p.SKU || p.id || null,
      name: p.name || p.title || null,
      supplier: p.supplier || p.brand || null,
      price: p.price ?? p.netPrice ?? null,
      grossPrice: p.grossPrice ?? null,
      stock: p.stock ?? p.quantity ?? null,
      status: p.status ?? null,
      updatedAt: p.updatedAt || p.modifiedAt || null,
    }));

    res.json({ count: normalized.length, items: normalized });
  } catch (err) {
    console.error('❌ DEV /unas/products hiba:', err?.response?.data || err);
    const msg = err?.response?.data?.error || err?.message || 'Ismeretlen hiba';
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
