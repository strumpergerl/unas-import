// backend/src/api/testUnas.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const http = require('http');
const https = require('https');
const { getBearerTokenForShop } = require('./unasAuth');

const BASE = process.env.UNAS_API_URL || 'https://api.unas.eu/shop';
const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

// Keep‑alive agentek (stabilabb kapcsolat az UNAS felé)
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 10 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 10 });

const { loadShopById } = require('./loadShops');
function getApiKeyForShop(shopId) {
	const shop = loadShopById(shopId);
	return shop.apiKey;
}
/** * XML POST kérés UNAS API-hoz, tokennel.*/
async function postXmlWithBearer(path, xmlBody, tokenGetter, shopId, apiKey) {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}`;

	const doPost = async (bearer) =>
		axios.post(`${BASE}/${path}`, xml, {
			headers: {
				'Content-Type': 'text/xml; charset=UTF-8',
				Authorization: `Bearer ${bearer}`,
				'Accept-Encoding': 'gzip,deflate', // engedjük a tömörített választ
			},
			timeout: 15000, // 15s
			httpAgent: keepAliveHttp,
			httpsAgent: keepAliveHttps,
			maxContentLength: Infinity,
			maxBodyLength: Infinity,
			decompress: true,
			validateStatus: () => true,
		});

	let bearer = await tokenGetter(shopId, apiKey);
	let resp = await doPost(bearer);

	if (resp.status === 401) {
		bearer = await tokenGetter(shopId, apiKey);
		resp = await doPost(bearer);
	}
	return resp;
}

router.get('/products', async (req, res) => {
	if (process.env.NODE_ENV === 'production') {
		return res
			.status(403)
			.json({ error: 'Test routes disabled in production' });
	}

	try {
		const { shopId, productIds, skus } = req.query;
		if (!shopId || (!productIds && !skus)) {
			return res.status(400).json({
				error:
					'Adj meg shopId-t és productIds vagy skus paramétert (vesszővel)!',
			});
		}

		const apiKey = getApiKeyForShop(shopId);
		const bearer = await getBearerTokenForShop(shopId, apiKey);

		const ids = (productIds ? String(productIds) : '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const skuList = (skus ? String(skus) : '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const results = [];

		// 1) Belső ID alapján (stabil)
		for (const pid of ids) {
			const payload = builder.buildObject({ getProduct: { productId: pid } });
			const resp = await postXmlWithBearer(
				'getProduct',
				payload,
				getBearerTokenForShop,
				shopId,
				apiKey
			);

			let parsed;
			try {
				parsed = await parser.parseStringPromise(resp.data);
			} catch {}
			const ok = resp.status >= 200 && resp.status < 300;
			results.push({
				productId: pid,
				ok,
				data: ok ? parsed : undefined,
				error: ok
					? undefined
					: {
							status: resp.status,
							statusText: resp.statusText,
							headers: resp.headers,
							raw: resp.data,
					  },
			});
		}

		// 2) SKU alapján (getProduct közvetlen mezőkkel), 1-esével
		for (const sku of skuList) {
			// Variáns A – közvetlen mezők, nagy kezdőbetűs root (sok helyen ez működik)
			const payloadA = builder.buildObject({
				GetProduct: {
					Sku: sku, // több SKU esetén vesszővel lehet elválasztani
					State: 'live', // csak létező termékek
					// StatusBase: '1,2,3', // ha aktív státuszokra szűrnél
					ContentType: 'full',
					LimitNum: 1,
					Lang: 'hu',
				},
			});

			let resp = await postXmlWithBearer(
				'getProduct',
				payloadA,
				getBearerTokenForShop,
				shopId,
				apiKey
			);

			// Variáns B – kisbetűs root (ha A nem 2xx)
			if (!(resp.status >= 200 && resp.status < 300)) {
				const payloadB = builder.buildObject({
					getProduct: {
						Sku: sku,
						State: 'live',
						ContentType: 'full',
						LimitNum: 1,
						Lang: 'hu',
					},
				});
				resp = await postXmlWithBearer(
					'getProduct',
					payloadB,
					getBearerTokenForShop,
					shopId,
					apiKey
				);
			}

			let parsed;
			try {
				parsed = await parser.parseStringPromise(resp.data);
			} catch {}
			const ok = resp.status >= 200 && resp.status < 300;

			// Próbáljuk kinyerni az első találatot – sémától függően több útvonal
			// (a raw-t is visszaadjuk, hogy ha kell, finomhangoljuk)
			const product =
				parsed?.Products?.Product ||
				parsed?.ProductList?.Products?.Product ||
				parsed?.ProductList?.Items?.Item ||
				parsed?.Product ||
				null;

			const productId =
				product?.Id ||
				product?.ID ||
				product?.ProductId ||
				product?.productId ||
				null;

			results.push({
				sku,
				ok,
				data: ok ? { product, productId, raw: parsed } : undefined,
				error: ok
					? undefined
					: {
							status: resp.status,
							statusText: resp.statusText,
							headers: resp.headers,
							raw: resp.data,
							hint: 'A getProduct mező-casing a fiókodat követi. A raw alapján pontosítjuk, ha kell.',
					  },
			});
		}

		res.json({ shopId, count: results.length, results });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

router.get('/login', async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: 'shopId kötelező' });

    const apiKey = getApiKeyForShop(shopId);
    const { getBearerTokenForShop } = require('./unasAuth');
    const token = await getBearerTokenForShop(shopId, apiKey);
    res.json({ shopId, ok: true, tokenMasked: token ? token.slice(0,6) + '…' : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
