// backend/src/core/uploadToUnas.js
require('../bootstrapEnv');
const axios = require('axios');
const xml2js = require('xml2js');
const http = require('http');
const https = require('https');
const { getBearerTokenForShop } = require('../api/unasAuth');
const { loadShopById } = require('../api/loadShops');
const csvParse = require('csv-parse/lib/sync');

const BASE_URL = process.env.UNAS_API_URL || 'https://api.unas.eu/shop';
const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 10 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 10 });

async function postXml(path, xmlBody, bearer) {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}`;
	return axios.post(`${BASE_URL}/${path}`, xml, {
		headers: {
			'Content-Type': 'text/xml; charset=UTF-8',
			Authorization: `Bearer ${bearer}`,
			'Accept-Encoding': 'gzip,deflate',
		},
		httpAgent: keepAliveHttp,
		httpsAgent: keepAliveHttps,
		timeout: 20000,
		maxContentLength: Infinity,
		maxBodyLength: Infinity,
		decompress: true,
		validateStatus: () => true,
	});
}


// SKU létezés ellenőrzés (true/false)
async function productExistsBySku(bearer, sku) {
	const payload = builder.buildObject({
		GetProduct: { Sku: sku, ContentType: 'full', LimitNum: 1, State: 'live' },
	});
	const resp = await postXml('getProduct', payload, bearer);
	if (resp.status < 200 || resp.status >= 300) return false;

	try {
		const parsed = await parser.parseStringPromise(resp.data);
		const product =
			parsed?.Products?.Product ||
			parsed?.ProductList?.Products?.Product ||
			parsed?.Product ||
			null;
		return Boolean(product);
	} catch {
		return false;
	}
}

async function uploadToUnas(records, processConfig, shopConfig) {
  const { dryRun = false, shopId } = processConfig;

  const shop = shopConfig || loadShopById(shopId);
  const bearer = await getBearerTokenForShop(shop.shopId, shop.apiKey);

  // Statisztikák gyűjtése
  const stats = {
    shopId: shop.shopId,
    shopName: shop.name,
    total: records.length,
    modified: [],          // sikeresen módosított SKU-k
    skippedNoSku: [],      // rekordok, ahol nem volt SKU
    skippedNotFound: [],   // SKU-k, amelyeket nem talált az UNAS (csak modify)
    failed: [],            // { sku, status, statusText, raw }
    dryRun: !!dryRun
  };

  if (dryRun) {
    console.log(`DRY RUN: ${records.length} tétel menne fel a(z) ${shop.name} boltba (Action=modify)`);
    return stats;
  }

  for (const rec of records) {
    const sku = rec.sku || rec.SKU || rec.Sku;
    if (!sku) {
      console.warn('[UNAS] Kihagyva: hiányzó SKU a rekordban:', rec);
      stats.skippedNoSku.push(rec);
      continue;
    }

    // Csak modify: ha nincs, kihagyjuk
    let exists = false;
    try {
      exists = await productExistsBySku(bearer, sku);
    } catch (e) {
      // ha a létezésellenőrzés is elszáll, tekintsük nem létezőnek és logoljuk
      console.warn(`[UNAS] Létezés-ellenőrzés hiba, SKU kihagyva: ${sku}`, e?.message || e);
      stats.skippedNotFound.push(sku);
      continue;
    }

    if (!exists) {
      console.log(`[UNAS] SKU nem található (kihagyva, csak modify engedett): ${sku}`);
      stats.skippedNotFound.push(sku);
      continue;
    }

    // UNAS Product node összerakása KANONIZÁLT mezőkből
    const productNode = { Sku: sku };
    if (rec.name != null) productNode.Name = String(rec.name);
    if (rec.description != null) productNode.Description = String(rec.description);
    if (rec.stock != null) {
      productNode.Stocks = {
        //Status: { Active: '1', Empty: '0', Variant: '0' },
        Stock: { Qty: String(rec.stock) },
      };
    }
    if (rec.price != null) {
      productNode.Prices = {
        Price: { Type: 'normal', Gross: String(rec.price), Actual: '1' },
      };
    }

    const payload = builder.buildObject({
      Products: {
        Product: {
          Action: 'modify',
          ...productNode,
        },
      },
    });
    if (process.env.DEBUG_UNAS_XML === '1') {
      console.debug(
        '[UNAS OUT XML]\n<?xml version="1.0" encoding="UTF-8"?>\n' + payload
      );
    }
    console.log(`→ [UNAS] setProduct (modify) SKU=${sku}`);
    try {
      const resp = await postXml('setProduct', payload, bearer);

      if (resp.status < 200 || resp.status >= 300) {
        console.error(`❌ [UNAS] setProduct hiba SKU=${sku}: ${resp.status} ${resp.statusText}`);
        // ne dobjuk tovább — gyűjtsük a hibát és menjünk tovább
        stats.failed.push({
          sku,
          status: resp.status,
          statusText: resp.statusText,
          raw: resp.data
        });
        continue;
      }

      console.log(`✓ [UNAS] módosítva SKU=${sku}`);
      stats.modified.push(sku);
    } catch (err) {
      // hálózati/axios hiba
      console.error(`❌ [UNAS] setProduct kivétel SKU=${sku}:`, err?.message || err);
      stats.failed.push({
        sku,
        status: err?.response?.status || null,
        statusText: err?.response?.statusText || String(err?.message || err),
        raw: err?.response?.data || null
      });
    }
  }

  return stats;
}

module.exports = uploadToUnas;
