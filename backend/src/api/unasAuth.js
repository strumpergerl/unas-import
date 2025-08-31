// backend/src/api/unasAuth.js
const axios = require('axios');
const xml2js = require('xml2js');

const BASE = process.env.UNAS_API_URL;
const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

// Egyszerű in-memory cache shoponként: { token, expire: Date }
const tokenCache = new Map();

/**
 * Login UNAS-hoz az apiKey-vel. Visszaad { token, expire }-t.
 */
async function unasLogin(apiKey, includeWebshopInfo = true) {
	const xmlObj = {
        Login: { ApiKey: apiKey, WebshopInfo: includeWebshopInfo ? 'true' : 'false' },
	};
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject(
		xmlObj
	)}`;

	const resp = await axios.post(`${BASE}/login`, xml, {
		headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
		timeout: 15000,
		validateStatus: () => true,
	});

	if (resp.status < 200 || resp.status >= 300) {
		const raw = resp.data;
		throw new Error(
			`UNAS login failed (${resp.status} ${resp.statusText}): ${
				typeof raw === 'string' ? raw : JSON.stringify(raw)
			}`
		);
	}

	const parsed = await parser.parseStringPromise(resp.data);
	// A valós mezőnevek az UNAS válasza szerint lehetnek: Token, Expire stb.
	const token =
		parsed?.LoginResponse?.Token || parsed?.token || parsed?.Login?.Token;
	const expireText =
		parsed?.LoginResponse?.Expire || parsed?.expire || parsed?.Login?.Expire;

	if (!token) throw new Error('UNAS login: Token missing in response');

	const expire = expireText
		? new Date(expireText)
		: new Date(Date.now() + 1000 * 60 * 20); // fallback 20 perc
	return { token, expire };
}

/**
 * Shop szintű token lekérő cache-eléssel.
 */
async function getBearerTokenForShop(shopId, apiKey) {
	const now = new Date();
	const cached = tokenCache.get(shopId);
	if (
		cached &&
		cached.token &&
		cached.expire &&
		cached.expire > new Date(now.getTime() + 60 * 1000)
	) {
		return cached.token;
	}
	const { token, expire } = await unasLogin(apiKey, false);
	tokenCache.set(shopId, { token, expire });
	return token;
}

module.exports = { getBearerTokenForShop };
