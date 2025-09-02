// backend/src/utils/currencyConverter.js
const { getRates } = require('./rateUpdater');

/**
 * Lekéri az aktuális árfolyamokat a rateUpdaterből.
 * Ha nincsenek frissítve, hibát dob.
 */
const fetchRates = async () => {
  const { rates } = getRates();
  if (!rates || Object.keys(rates).length === 0) {
    throw new Error('Nincsenek elérhető árfolyamok. Kérjük, frissítse az árfolyamokat.');
  }
  return rates;
};

/**
 * Átvált egy összeget bármilyen devizából bármilyen devizába.
 * @param {number} amount — alapösszeg
 * @param {string} fromCurrency — kiinduló deviza, pl. 'EUR'
 * @param {string} toCurrency — céldeviza, pl. 'HUF'
 */
async function convertCurrency(amount, fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency) {
    throw new Error('convertCurrency: fromCurrency és toCurrency kötelező');
  }

  const rates = await fetchRates();

  const fromRate = rates[fromCurrency];
  const toRate = rates[toCurrency];
  if (!fromRate) throw new Error(`Ismeretlen valutakód: ${fromCurrency}`);
  if (!toRate) throw new Error(`Ismeretlen valutakód: ${toCurrency}`);

  return amount * (fromRate / toRate);
}

module.exports = { convertCurrency, fetchRates };
