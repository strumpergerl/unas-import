const processes = require('./config/processes.json');

/**
 * Átvált egy összeget bármilyen devizából bármilyen devizába.
 * @param {number} amount — alapösszeg
 * @param {string} fromCurrency — kiinduló deviza, pl. 'EUR'
 * @param {string} toCurrency — céldeviza, pl. 'HUF'
 */
async function convertCurrency(amount, fromCurrency, toCurrency) {
    const rates = await fetchRates();
    // If fromCurrency is not provided, use the one from processes.json
    const sourceCurrency = fromCurrency || processes.currency;
    const targetCurrency = toCurrency || 'HUF';

    const fromRate = rates[sourceCurrency];
    const toRate = rates[targetCurrency];
    if (!fromRate) throw new Error(`Ismeretlen valutakód: ${sourceCurrency}`);
    if (!toRate) throw new Error(`Ismeretlen valutakód: ${targetCurrency}`);
    return amount / fromRate * toRate;
}

module.exports = { convertCurrency };
module.exports.fetchRates = fetchRates;