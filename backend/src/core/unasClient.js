// backend/src/core/unasClient.js
const axios = require('axios');

function createUnasClient(shop) {
  const baseURL = shop.baseUrl || process.env.UNAS_API_URL || 'https://api.unas.eu/shop';

  const http = axios.create({
    baseURL,
    headers: { 'X-API-KEY': shop.apiKey },
    timeout: 15000,
  });

  async function getProductBySku(sku) {
    const { data } = await http.get(`/products/${encodeURIComponent(sku)}`);
    return Array.isArray(data) ? data : [data];
  }

  async function searchProducts({ name, supplier, limit = 100, pageSize = 100 }) {
    // 1) próbálkozás query paramokkal
    try {
      const params = new URLSearchParams();
      if (name) params.set('search', name);
      if (supplier) params.set('supplier', supplier);
      params.set('limit', String(Math.min(limit, pageSize)));
      const { data } = await http.get(`/products?${params.toString()}`);
      const arr = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      return arr.slice(0, limit);
    } catch {
      // 2) fallback: lapozás + lokális szűrés (dev célra)
      const results = [];
      let page = 1;
      while (results.length < limit && page <= 10) {
        const params = new URLSearchParams();
        params.set('limit', String(pageSize));
        params.set('page', String(page));
        const { data } = await http.get(`/products?${params.toString()}`);
        const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
        if (!items.length) break;

        const filtered = items.filter(p => {
          const nm = String(p.name || p.title || '').toLowerCase();
          const sup = String(p.supplier || p.brand || '').toLowerCase();
          const byName = name ? nm.includes(String(name).toLowerCase()) : true;
          const bySupplier = supplier ? sup.includes(String(supplier).toLowerCase()) : true;
          return byName && bySupplier;
        });
        results.push(...filtered);
        if (items.length < pageSize) break;
        page += 1;
      }
      return results.slice(0, limit);
    }
  }

  return { getProductBySku, searchProducts };
}

module.exports = { createUnasClient };
