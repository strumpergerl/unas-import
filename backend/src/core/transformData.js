const Big = require('big.js');


function transformData(records, processConfig) {
  const { fieldMapping, pricingFormula, rounding } = processConfig;
  return records.map(record => {
    const transformed = { /* más mezők átadása… */ };

    if (pricingFormula) {
      // 1) Megkeressük, melyik forrás-mező tartozik a 'price' kulcshoz
      const baseKey = Object
        .entries(fieldMapping)
        .find(([, target]) => target === 'price')?.[0];
      // 2) Először defaultoljuk null/üres esetén '0'-ra
      let rawPrice = record[baseKey];
      rawPrice = rawPrice == null || rawPrice === '' ? '0' : String(rawPrice);
      // 3) Csak számjegyek, pont és kötőjel maradjon meg
      const cleanPrice = rawPrice.replace(/[^0-9.\-]/g, '') || '0';
      const basePrice = Big(cleanPrice);

      // 4) Kivonjuk a pricingFormula operátort és tényezőt
      const match = pricingFormula.match(/base\s*([*\/+\-])\s*(\d+(?:\.\d+)?)/);
      if (match) {
        const [, operator, factorStr] = match;
        const cleanFactor = (factorStr || '1').replace(/[^0-9.\-]/g, '') || '1';
        const factor = Big(cleanFactor);

        let price = basePrice;
        switch (operator) {
          case '*': price = price.times(factor); break;
          case '/': price = price.div(factor); break;
          case '+': price = price.plus(factor); break;
          case '-': price = price.minus(factor); break;
        }

        // 5) Kerekítés half-up a rounding mező szerint
        const rounded = price
          .round(0, Big.roundHalfUp)       // először egészekre
          .div(rounding)                   // osztás a kerekítési egységgel
          .round(0, Big.roundHalfUp)       // újrakerekítés egészekre
          .times(rounding);                // visszaszorzás
        transformed.price = rounded.toString();
      }
    }

    return transformed;
  });
}

module.exports = transformData;