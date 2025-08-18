const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

const API_KEY = process.env.UNAS_API_KEY;
const BASE_URL = process.env.UNAS_API_URL || 'https://api.unas.eu/shop';
const parser = new xml2js.Parser();
const builder = new xml2js.Builder({ headless: true });

async function uploadToUnas(records, processConfig, shopConfig) {
  const { dryRun } = processConfig;
  if (dryRun) {
    console.log(`DRY RUN: Would sync ${records.length} items`);
    console.dir(records, { depth: null });
    return;
  }

  for (const rec of records) {
    // 1. Lekérjük létező terméket (opcionális)
    console.log(rec.name);
    const getReq = { getProduct: { apiKey: API_KEY, productId: rec.sku } };
    const getXml = `<?xml version="1.0" encoding="UTF-8"?>
    ${builder.buildObject(getReq)}`;
    try {
      const getRes = await axios.post(
        `${BASE_URL}/getProduct`,
        getXml,
        { headers: { 'Content-Type': 'text/xml' } }
      );
      const existing = await parser.parseStringPromise(getRes.data);
      console.log('Existing product:', existing);
    } catch (_) {
      // Ha nincs termék, folytatjuk
    }

    // 2. Feltöltés vagy frissítés
    const productNode = {};
    for (const [src, tgt] of Object.entries(processConfig.fieldMapping)) {
      productNode[tgt] = rec[src] ?? '';
    }
    const setReq = { setProduct: { apiKey: API_KEY, product: productNode } };
    const setXml = '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.buildObject(setReq);

    // **Debug logok**
    console.log('→ [UNAS] POST /setProduct XML:\n', setXml);

    try {
      console.log(`→ [UNAS] Sending setProduct for SKU: ${rec.sku}`);
      
      const setRes = await axios.post(
        `${BASE_URL}/setProduct`,
        setXml,
        { headers: { 'Content-Type': 'text/xml' } }
      );
      console.log(`← [UNAS] Response status: ${setRes.status}\n`, setRes.data);
    } catch (err) {
      console.error('❌ [UNAS] setProduct hiba, request XML és response:');
      console.error(setXml);
      console.error(err.response?.data || err.message);
      throw err;
    }
    console.log(`Product ${rec.sku} synced, status: ${setRes.status}`);
  }
}

module.exports = uploadToUnas;