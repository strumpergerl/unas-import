const Big = require('big.js');
const { convertCurrency } = require('../utils/currencyConverter');

/**
 * @param {Array<Object>} records — forrásadatok
 * @param {Object} processConfig
 * @param {Object} processConfig.fieldMapping — { forrásMező: célKulcs, … }
 * @param {string} [processConfig.pricingFormula] — pl. "base * 1.2"
 * @param {number} [processConfig.rounding] — kerekítési egység, pl. 10
 * @param {boolean} [processConfig.convertCurrency] — devizakonverzió bekapcsolása
 * @param {string} [processConfig.targetCurrency] — céldeviza kód, pl. 'EUR'
 * @returns {Promise<Array<Object>>}
 */
async function transformData(records, processConfig) {
  const {
    fieldMapping,
    pricingFormula,
    rounding = 1,
    convertCurrency: doConvert = false,
    targetCurrency = 'USD'
  } = processConfig;

  // Feldolgozás párhuzamosan, Promise-okkal
  const transformedList = await Promise.all(records.map(async record => {
    const transformed = {};

    // 1) Általános mező-mapping (kivéve price)
    for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
      if (dstKey !== 'price') {
        transformed[dstKey] = record[srcKey];
      }
    }

    // 2) Ár számítása, ha van formula
    if (pricingFormula) {
      // a price-hoz tartozó forrásmező kulcsa
      const baseKey = Object
        .entries(fieldMapping)
        .find(([, dst]) => dst === 'price')?.[0];

      // nyers ár letisztítása
      let raw = record[baseKey];
      raw = raw == null || raw === '' ? '0' : String(raw);
      const clean = raw.replace(/[^0-9.\-]/g, '') || '0';
      let price = Big(clean);

      // 3) pricingFormula alkalmazása (pl. "base * 1.2", vagy "base / 2 + 10")
      const m = pricingFormula.match(/base\s*([*\/+\-])\s*(\d+(\.\d+)?)/);
      if (m) {
        const [, op, factorStr] = m;
        const factor = Big(factorStr);
        switch (op) {
          case '*': price = price.times(factor); break;
          case '/': price = price.div(factor); break;
          case '+': price = price.plus(factor); break;
          case '-': price = price.minus(factor); break;
        }
      }

      // 4) Devizakonverzió USD-ről céldevizára
      if (doConvert !== 'HUF') {
        // convertCurrency visszaadja a konvertált összeget Number-ként
        const converted = await convertCurrency(price.toNumber(), targetCurrency);
        price = Big(converted);
      }
      else {
        // HUF esetén csak a számot hagyjuk, de nem konvertálunk
        price = Big(price.toNumber());
      }
      // 5) Kerekítés half-up a megadott egységre
      const rounded = price
        .round(0, Big.roundHalfUp)    // egészre
        .div(rounding)                // egységre oszt
        .round(0, Big.roundHalfUp)    // újra egész
        .times(rounding);             // visszaszorz

      transformed.price = rounded.toString();
    }

    return transformed;
  }));

  return transformedList;
}

module.exports = transformData;