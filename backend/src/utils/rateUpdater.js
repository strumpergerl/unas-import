
const cron = require('node-cron');
const axios = require('axios');
const currencies = require('../config/currencies.json');

let rates = {}; 
let lastUpdated = null;

/**
 * Lekéri és frissíti a rates objektumot.
 */
async function updateRates() {
  try {
    const appId = process.env.OER_APP_ID;
    if (!appId) throw new Error('OER_APP_ID nincs beállítva');
    
    const url = `https://openexchangerates.org/api/latest.json?app_id=${appId}`;
    const resp = await axios.get(url);
    const all = resp.data.rates;
    
    // csak a configban lévő valutákat vesszük át
    rates = currencies.reduce((acc, code) => {
      if (all[code]) acc[code] = all[code];
      return acc;
    }, {});
    
    lastUpdated = new Date();
    console.log(`[rateUpdater] Árfolyamok frissítve (${lastUpdated.toISOString()})`);
    
    if (typeof global !== 'undefined' && global.res && global.res.cookie) {
        global.res.cookie('exchangeRates', JSON.stringify(rates), {
            maxAge: 6 * 60 * 60 * 1000, // 6 hours
            httpOnly: true,
            sameSite: 'strict'
        });
    }
  } catch (err) {
    console.error('[rateUpdater] Hiba árfolyam lekéréskor:', err.message);
  }
}

// indításkor azonnal
updateRates();

// mentsük el cookie-ba, hogy ne kelljen minden alkalommal lekérni és 6 óránként frissítjük
cron.schedule('0 */6 * * *', () => {
  console.log('[rateUpdater] Árfolyam frissítés ütemezve');
  updateRates();
}, {
  scheduled: true,
  timezone: 'Europe/Budapest'
});

/**
 * Visszaadja a legutolsó árfolyamokat és frissítés idejét.
 */
function getRates() {
  return {
    rates,
    lastUpdated,
  };
}

module.exports = { getRates };
