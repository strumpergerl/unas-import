const Big = require('big.js');


/**
 * Átalakítja a rekordokat Unas-kompatibilis formátumra.
 * @param {Array<object>} records - A beolvasott rekordok tömbje.
 * @param {object} processConfig - A `processes.json`-beli konfiguráció egy eleme.
 * @returns {Array<object>} - Az átalakított rekordok tömbje.
 */
function transformData(records, processConfig) {
  const {
    fieldMapping,
    pricingFormula,
    rounding,
    convertCurrency,
    targetCurrency,
    fxProvider
  } = processConfig;

  return records.map(record => {
    const transformed = {};

    // Mezőleképezés
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      transformed[targetField] = record[sourceField];
    }

    // Árképzés
    if (pricingFormula) {
      const baseKey = Object.keys(fieldMapping).find(key => fieldMapping[key] === 'price');
      const basePrice = Big(record[baseKey]);
      const match = pricingFormula.match(/base\s*([*\/\+\-])\s*(\d+(?:\.\d+)?)/);
      if (match) {
        const [, operator, factor] = match;
        let price = basePrice;
        switch (operator) {
          case '*': price = price.times(factor); break;
          case '/': price = price.div(factor); break;
          case '+': price = price.plus(factor); break;
          case '-': price = price.minus(factor); break;
        }
        // Kerekítés
        transformed.price = price.round(0, 0).mul(rounding).div(rounding).toString();
      }
    }

    // Valuta konverzió
    if (convertCurrency) {
      // TODO: FX provider hívás: fxProvider, record[currency]
      transformed.price = `CONVERTED:${transformed.price}`;
      transformed.currency = targetCurrency;
    }

    return transformed;
  });
}

// test('pricingFormula alkalmazása és kerekítés', () => {
//   const records = [{ Price: '100' }];
//   const config = {
//     fieldMapping: { Price: 'price' },
//     pricingFormula: 'base*1.2',
//     rounding: 100,
//     convertCurrency: false
//   };
//   const result = transformData(records, config);
//   expect(result[0].price).toBe('120');
// });

module.exports = transformData;