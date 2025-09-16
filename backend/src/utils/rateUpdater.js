// backend/src/utils/rateUpdater.js
require('../bootstrapEnv');
const cron = require('node-cron');
const axios = require('axios');
const currencies = require('../config/currencies.json');

let rates = {};
let lastUpdated = null;
const appId = process.env.OER_APP_ID;

/**
 * Lekéri és frissíti a rates objektumot.
 */
async function updateRates(retry = true) {
  console.log(appId);
	try {
		const url = appId
			? `https://openexchangerates.org/api/latest.json?app_id=${appId}`
			: `https://openexchangerates.org/api/latest.json`; // ingyenes appId nélkül is megy, de limitált, várhatóan 401
		const resp = await axios.get(url);
		const all = resp.data?.rates || {};

		// csak a configban lévő valutákat vesszük át
		rates = currencies.reduce((acc, code) => {
			if (Object.prototype.hasOwnProperty.call(all, code))
				acc[code] = all[code];
			return acc;
		}, {});

		lastUpdated = new Date();
		console.log(
			`[rateUpdater] Árfolyamok frissítve (${lastUpdated.toISOString()})`
		);

		// süti-beállítás (ha van global.res)
		if (typeof global !== 'undefined' && global.res && global.res.cookie) {
			global.res.cookie('exchangeRates', JSON.stringify(rates), {
				maxAge: 6 * 60 * 60 * 1000, 
				httpOnly: true,
				sameSite: 'strict',
			});
		}
	} catch (err) {
		console.error('[rateUpdater] Hiba árfolyam lekéréskor:', err.message);
	} finally {
		// Ha üres maradt a rates, próbálja újra 10 másodperc múlva (csak egyszer)
		if (Object.keys(rates).length === 0 && retry) {
			console.warn(
				'[rateUpdater] Árfolyamok üresek, újrapróbálkozás 10 másodperc múlva...'
			);
			setTimeout(() => updateRates(false), 10000);
		}
	}
}

// indításkor azonnal
updateRates();

// 1 óránként frissítjük az árfolyamokat
// ToDo: ideiglenesen 1 óra
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
	if (!rates['HUF']) return { rates: {}, lastUpdated };
	const hufRates = {};
	for (const [cur, usdToCur] of Object.entries(rates)) {
		if (cur === 'HUF') hufRates[cur] = 1;
		else hufRates[cur] = rates['HUF'] / usdToCur;
	}
	return { rates: hufRates, lastUpdated };
}

module.exports = { updateRates, getRates };
