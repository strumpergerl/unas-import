// backend/src/services/unas.js
require('../bootstrapEnv');
const axios = require('axios');
const xml2js = require('xml2js');
const { createTTLCache } = require('../shared/cache');
const { BadRequestError, AppError } = require('../shared/errors');

const UNAS_BASE = (
	process.env.UNAS_API_URL || 'https://api.unas.eu/shop'
).replace(/\/+$/, '');
const UNAS_TIMEOUT_MS = Number(process.env.UNAS_TIMEOUT_MS ?? 120000);
const UNAS_DOWNLOAD_TIMEOUT_MS = Number(
	process.env.UNAS_DOWNLOAD_TIMEOUT_MS ?? 300000
);

const http = axios.create({
	timeout: UNAS_TIMEOUT_MS,
	validateStatus: (s) => s >= 200 && s < 500,
});

const parser = new xml2js.Parser({ explicitArray: false });
const builder = new xml2js.Builder({ headless: true });

// 20 perces token-cache
const tokenCache = createTTLCache(20 * 60 * 1000);
// 1 órás fields cache
const fieldsCache = createTTLCache(60 * 60 * 1000);

async function unasLogin(apiKey, webshopInfo = true) {
	// Use the parameters and correct variable names
	const xmlRequest = `<Params><ApiKey>${apiKey}</ApiKey><WebshopInfo>${
		webshopInfo ? 'true' : 'false'
	}</WebshopInfo></Params>`;

	// Use the http module instead of https
	const http = require('http');

	return new Promise((resolve, reject) => {
		const options = {
			hostname: 'api.unas.eu',
			path: '/shop/login',
			method: 'POST',
			headers: {
				'Content-Type': 'application/xml',
				'Content-Length': Buffer.byteLength(xmlRequest),
			},
		};

		const req = http.request(options, (res) => {
			let data = '';
			console.log('Login HTTP státusz:', res.statusCode);
			res.on('data', (chunk) => {
				//console.log("Login chunk:", chunk.toString());
				data += chunk;
			});
			res.on('end', () => {
				console.log('Login end');
				const tokenMatch = data.match(/<Token>([^<]+)<\/Token>/);
				if (!tokenMatch) {
					return reject(new Error('Nincs token. Válasz: ' + data));
				}
				resolve(tokenMatch[1]);
			});
		});

		req.on('error', (err) => {
			console.error('Login HTTP hiba:', err);
			reject(err);
		});

		req.write(xmlRequest);
		req.end();
	});
}

async function getTokenCached(apiKey) {
	const hit = tokenCache.get(apiKey);
	if (hit) return hit;
	const t = await unasLogin(apiKey, true);
	tokenCache.set(apiKey, t);
	return t;
}

function extractLinkFromXmlOrText(txt) {
	const s = String(txt || '');
	const m1 = s.match(/<Url>([^<]+)<\/Url>/i);
	if (m1) return m1[1];
	const m2 = s.match(/<Link>([^<]+)<\/Link>/i);
	if (m2) return m2[1];
	const trimmed = s.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return null;
}

async function requestProductDbLink(token, paramsXml) {
	const body =
		paramsXml && paramsXml.trim()
			? paramsXml
			: `<?xml version="1.0" encoding="UTF-8"?>
<Params><Format>csv2</Format></Params>`;

	const resp = await http.post(`${UNAS_BASE}/getProductDB`, body, {
		headers: {
			'Content-Type': 'application/xml; charset=UTF-8',
			Authorization: `Bearer ${token}`,
		},
		responseType: 'text',
	});

	if (resp.status !== 200) {
		throw new AppError(
			`getProductDB generálás sikertelen HTTP ${resp.status} — ${String(
				resp.data
			).slice(0, 400)}`,
			'UNAS_PRODUCTDB_GEN'
		);
	}

	const link = extractLinkFromXmlOrText(resp.data);
	if (!link)
		throw new AppError(
			'getProductDB: hiányzik a letöltési link (Url/Link).',
			'UNAS_PRODUCTDB_LINK'
		);
	return link;
}

async function fetchProductDbHeaders({ apiKey, paramsXml }) {
	// shopId NEM kell ehhez a flow-hoz → a token azonosítja a shopot
	const cached = fieldsCache.get('headers');
	if (cached) return { unasShopId: null, headers: cached }; // unasShopId itt nem releváns

	const token = await getTokenCached(apiKey);
	const link = await requestProductDbLink(token, paramsXml);

	// CSV letöltés
	const dl = await axios.get(link, {
		responseType: 'arraybuffer',
		timeout: UNAS_DOWNLOAD_TIMEOUT_MS,
		validateStatus: (s) => s >= 200 && s < 400,
	});
	if (dl.status !== 200) {
		throw new AppError(
			`getProductDB letöltés sikertelen HTTP ${dl.status}`,
			'UNAS_PRODUCTDB_DL'
		);
	}

	function detectDelimiter(line) {
		// számoljuk a ; , és \t előfordulásokat, és a leggyakoribbat választjuk
		const counts = {
			';': (line.match(/;/g) || []).length,
			',': (line.match(/,/g) || []).length,
			'\t': (line.match(/\t/g) || []).length,
		};
		return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ';';
	}

	function parseCsvLine(line, delim) {
		// idézőjeles CSV mező-parser egy sorra
		const out = [];
		let cur = '';
		let inQuotes = false;

		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (ch === '"') {
				if (inQuotes && line[i + 1] === '"') {
					cur += '"';
					i++; // duplázott idéző → egy idéző karakter
				} else {
					inQuotes = !inQuotes;
				}
			} else if (ch === delim && !inQuotes) {
				out.push(cur);
				cur = '';
			} else {
				cur += ch;
			}
		}
		out.push(cur);
		// vágás + külső idézők lefejtése
		return out
			.map((s) => {
				let v = s.trim();
				if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
				return v;
			})
			.filter(Boolean);
	}

	let csvText = Buffer.from(dl.data).toString('utf8');
	if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
	const firstLine =
		csvText.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
	const delim = detectDelimiter(firstLine);
	const headers = parseCsvLine(firstLine, delim);

	fieldsCache.set('headers', headers);
	return { unasShopId: null, headers };
}

module.exports = {
	// a router ezt hívja → csak apiKey kell
	fetchProductDbHeaders,
	getBearerToken: getTokenCached,
	ensureUnasShopId: async () => null,
};
