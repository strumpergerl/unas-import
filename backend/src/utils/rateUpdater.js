// backend/src/utils/rateUpdater.js
require('../bootstrapEnv');
const cron = require('node-cron');
const axios = require('axios');
const currencies = require('../config/currencies.json');
const { db } = require('../db/firestore');

let rates = {};
let lastUpdated = null;
const appId = process.env.OER_APP_ID;

const RATES_COLL = 'rates_cache';
const RATES_DOC = 'rates';
const RATES_TTL_MS = Number(process.env.RATES_TTL_MS || 6 * 60 * 60 * 1000); // 6 óra
let pendingUpdate = null; // single-flight védelem
async function saveRatesToStore(usdRates, sourceUpdatedAt) {
	try {
		const payload = {
			usdRates, // OER-ből jövő USD→CUR árfolyamok (szűrve)
			sourceUpdatedAt: sourceUpdatedAt || new Date().toISOString(),
			cachedAt: new Date().toISOString(),
		};
		await db
			.collection(RATES_COLL)
			.doc(RATES_DOC)
			.set(payload, { merge: true });
	} catch (e) {
		console.warn('[rateUpdater] Firestore mentés sikertelen:', e?.message || e);
	}
}

async function loadRatesFromStore(maxAgeMs = RATES_TTL_MS) {
	try {
		const snap = await db.collection(RATES_COLL).doc(RATES_DOC).get();
		if (!snap.exists) return null;
		const data = snap.data() || {};
		const age = Date.now() - new Date(data.cachedAt || 0).getTime();
		if (Number.isFinite(maxAgeMs) && age > maxAgeMs) {
			return {
				stale: true,
				usdRates: data.usdRates || {},
				sourceUpdatedAt: data.sourceUpdatedAt,
			};
		}
		return {
			stale: false,
			usdRates: data.usdRates || {},
			sourceUpdatedAt: data.sourceUpdatedAt,
		};
	} catch (e) {
		console.warn('[rateUpdater] Firestore olvasás hiba:', e?.message || e);
		return null;
	}
}

// /**
//  * Lekéri és frissíti a rates objektumot.
//  */
// async function updateRates(retry = true) {
//   console.log(appId);
// 	try {
// 		const url = appId
// 			? `https://openexchangerates.org/api/latest.json?app_id=${appId}`
// 			: `https://openexchangerates.org/api/latest.json`; // ingyenes appId nélkül is megy, de limitált, várhatóan 401
// 		const resp = await axios.get(url);
// 		const all = resp.data?.rates || {};

// 		// csak a configban lévő valutákat vesszük át
// 		rates = currencies.reduce((acc, code) => {
// 			if (Object.prototype.hasOwnProperty.call(all, code))
// 				acc[code] = all[code];
// 			return acc;
// 		}, {});

// 		lastUpdated = new Date();
// 		console.log(
// 			`[rateUpdater] Árfolyamok frissítve (${lastUpdated.toISOString()})`
// 		);

// 		// süti-beállítás (ha van global.res)
// 		if (typeof global !== 'undefined' && global.res && global.res.cookie) {
// 			global.res.cookie('exchangeRates', JSON.stringify(rates), {
// 				maxAge: 6 * 60 * 60 * 1000,
// 				httpOnly: true,
// 				sameSite: 'strict',
// 			});
// 		}
// 	} catch (err) {
// 		console.error('[rateUpdater] Hiba árfolyam lekéréskor:', err.message);
// 	} finally {
// 		// Ha üres maradt a rates, próbálja újra 10 másodperc múlva (csak egyszer)
// 		if (Object.keys(rates).length === 0 && retry) {
// 			console.warn(
// 				'[rateUpdater] Árfolyamok üresek, újrapróbálkozás 1 másodperc múlva...'
// 			);
// 			setTimeout(() => updateRates(false), 1000);
// 		}
// 	}
// }

async function updateRates(retry = true) {
	// single-flight: ha már folyamatban van lekérés, csatlakozzunk
	if (pendingUpdate) return pendingUpdate;
	const backoffPlan = retry ? [1000, 3000, 7000, 15000] : [0];

	pendingUpdate = (async () => {
		let lastErr = null;
		for (let i = 0; i < backoffPlan.length; i++) {
			try {
				const url = appId
					? `https://openexchangerates.org/api/latest.json?app_id=${appId}`
					: `https://openexchangerates.org/api/latest.json`;
				const resp = await axios.get(url);
				const all = resp.data?.rates || {};
				// csak a configban lévő valutákat vesszük át
				const filtered = currencies.reduce((acc, code) => {
					if (Object.prototype.hasOwnProperty.call(all, code))
						acc[code] = all[code];
					return acc;
				}, {});
				// HUF guard (elméletileg OER ad HUF-ot, de védjük)
				if (!filtered['HUF']) filtered['HUF'] = all['HUF'] || 1;

				rates = filtered;
				lastUpdated = new Date();

				await saveRatesToStore(
					filtered,
					resp.data?.timestamp
						? new Date(resp.data.timestamp * 1000).toISOString()
						: lastUpdated.toISOString()
				);

				console.log(
					`[rateUpdater] Árfolyamok frissítve (${lastUpdated.toISOString()})`
				);
				// opcionális "cookie" log maradhat
				if (typeof global !== 'undefined' && global.res && global.res.cookie) {
					global.res.cookie('exchangeRates', JSON.stringify(rates), {
						maxAge: 6 * 60 * 60 * 1000,
						sameSite: 'strict',
					});
				}
				return rates;
			} catch (err) {
				lastErr = err;
				console.error(
					'[rateUpdater] Hiba árfolyam lekéréskor:',
					err?.message || err
				);
				const wait = backoffPlan[i];
				if (wait) await new Promise((r) => setTimeout(r, wait));
			}
		}
		// ha végig hibázott: próbáljunk perzisztens cache-ből olvasni (akár lejárt is)
		const stored = await loadRatesFromStore(/*maxAgeMs*/ null);
		if (stored?.usdRates && Object.keys(stored.usdRates).length) {
			rates = stored.usdRates;
			lastUpdated = new Date(stored.sourceUpdatedAt || Date.now());
			console.warn(
				'[rateUpdater] Élő letöltés sikertelen, LEJÁRT perzisztens árfolyamot használunk.'
			);
			return rates;
		}
		throw (
			lastErr ||
			new Error('Árfolyam frissítés sikertelen és nincs perzisztens cache.')
		);
	})().finally(() => {
		pendingUpdate = null;
	});

	return pendingUpdate;
}

// indításkor azonnal
updateRates();

// 1 óránként frissítjük az árfolyamokat
cron.schedule(
	'0 */1 * * *',
	() => {
		console.log('[rateUpdater] Árfolyam frissítés ütemezve');
		updateRates();
	},
	{ scheduled: true, timezone: 'Europe/Budapest' }
);

/**
 * Visszaadja a legutolsó árfolyamokat és frissítés idejét.
 * A visszatérő rates HUF-bázisú (HUF=1).
 */
function getRates() {
	// Ha in-memory üres, próbáljunk perzisztens cache-t (friss → majd lejárt)
	if (!rates || Object.keys(rates).length === 0) {
		// szinkron API, de Firestore async → itt csak jelzünk, hogy üres;
		// a hívó (convertCurrency/fetchRates) úgyis megpróbál élő frissítést.
		return { rates: {}, lastUpdated };
	}
	if (!rates['HUF']) return { rates: {}, lastUpdated };
	const hufRates = {};
	for (const [cur, usdToCur] of Object.entries(rates)) {
		if (cur === 'HUF') hufRates[cur] = 1;
		else hufRates[cur] = rates['HUF'] / usdToCur;
	}
	return { rates: hufRates, lastUpdated };
}

module.exports = { updateRates, getRates };
