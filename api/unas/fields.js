// api/unas/fields.js
const { db } = require('../../backend/src/db/firestore');
const { BadRequestError } = require('../../backend/src/shared/errors');
const { fetchProductDbHeaders } = require('../../backend/src/services/unas');
const { loadShopById } = require('../../backend/src/services/shops');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { shopId, processId } = req.query || {};
    if (!shopId) return res.status(400).json({ error: 'shopId szükséges' });

    const shop = await loadShopById(shopId);
    const { apiKey } = shop;

    let paramsXml = null;
    if (processId) {
      const doc = await db.collection('processes').doc(String(processId)).get();
      if (doc.exists) {
        const pc = doc.data() || {};
        paramsXml =
          pc?.productDb?.paramsXml || pc?.unas?.productDb?.paramsXml || null;
      }
    }

    const { headers } = await fetchProductDbHeaders({ apiKey, paramsXml });
    const fields = headers.map((h) => ({
      key: String(h.key || h),
      label: String(h.label || h),
      id: h.id !== undefined ? String(h.id) : null,
    }));

    return res.json({ shopId, count: fields.length, fields });
  } catch (e) {
    console.error('[GET /api/unas/fields] error:', e);
    const status = e?.code === 'BAD_REQUEST' ? 400 : 500;
    return res
      .status(status)
      .json({ error: e.message || 'Hiba', code: e.code || 'ERR' });
  }
};
