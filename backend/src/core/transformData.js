const Big = require('big.js');
const { convertCurrency } = require('../utils/currencyConverter');

/**
 * Token-alapú képlet kiértékelés Big.js-zel.
 * Támogatott tokenek: {basePrice}, {discount}, {priceMargin}, {vat}
 * Operátorok: + - * / és zárójelek ( )
 * Számok: tizedesponttal (pl. 1.2)
 *
 * @param {string} formula - pl. "{basePrice}*{discount}*{priceMargin}*{vat}"
 * @param {Object} values  - { basePrice: Big, discount: Big, priceMargin: Big, vat: Big }
 * @returns {Big}
 */
function evalFormula(formula, values) {
  if (!formula || typeof formula !== 'string') {
    throw new Error('pricingFormula is empty or not a string');
  }

  // 1) Tokenizálás
  const tokens = tokenize(formula);

  // 2) Tokenek validálása és helyettesítés Big értékekre / operátorokra
  const normalized = tokens.map(t => {
    if (isWhitespace(t)) return null; // elhagyjuk
    if (isNumber(t)) return Big(t);
    if (isOperator(t) || isParen(t)) return t;

    switch (t) {
      case '{basePrice}': return values.basePrice;
      case '{discount}': return values.discount;
      case '{priceMargin}': return values.priceMargin;
      case '{vat}': return values.vat;
      default:
        throw new Error(`Unknown token in pricingFormula: ${t}`);
    }
  }).filter(Boolean);

  // 3) Shunting-yard: infix -> RPN
  const rpn = toRPN(normalized);

  // 4) RPN kiértékelés Big-gel
  return evalRPN(rpn);
}

/** ----- Segédfüggvények a képlet kiértékeléséhez ----- */

function tokenize(text) {
  // {basePrice} | {discount} | {priceMargin} | {vat} | szám | operátor | zárójel | whitespace
  const re = /(\{basePrice\}|\{discount\}|\{priceMargin\}|\{vat\}|\d+(?:\.\d+)?|[+\-*/()]|\s+)/g;
  const raw = text.match(re);
  if (!raw) {
    throw new Error('pricingFormula contains no valid tokens');
  }
  return raw;
}
function isWhitespace(t) { return /^\s+$/.test(t); }
function isNumber(t) { return /^\d+(?:\.\d+)?$/.test(String(t)); }
function isOperator(t) { return t === '+' || t === '-' || t === '*' || t === '/'; }
function isParen(t) { return t === '(' || t === ')'; }
function precedence(op) {
  return (op === '+' || op === '-') ? 1 :
         (op === '*' || op === '/') ? 2 : 0;
}
function toRPN(seq) {
  const out = [];
  const stack = [];
  for (const t of seq) {
    if (t instanceof Big) {
      out.push(t);
    } else if (isOperator(t)) {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (isOperator(top) && precedence(top) >= precedence(t)) {
          out.push(stack.pop());
        } else break;
      }
      stack.push(t);
    } else if (t === '(') {
      stack.push(t);
    } else if (t === ')') {
      let found = false;
      while (stack.length) {
        const top = stack.pop();
        if (top === '(') { found = true; break; }
        out.push(top);
      }
      if (!found) throw new Error('Mismatched parentheses in pricingFormula');
    } else {
      throw new Error(`Invalid token during RPN conversion: ${t}`);
    }
  }
  while (stack.length) {
    const top = stack.pop();
    if (top === '(' || top === ')') throw new Error('Mismatched parentheses in pricingFormula');
    out.push(top);
  }
  return out;
}
function evalRPN(rpn) {
  const st = [];
  for (const t of rpn) {
    if (t instanceof Big) {
      st.push(t);
    } else if (isOperator(t)) {
      const b = st.pop();
      const a = st.pop();
      if (!(a instanceof Big) || !(b instanceof Big)) {
        throw new Error('Invalid expression (not enough operands)');
      }
      let res;
      switch (t) {
        case '+': res = a.plus(b); break;
        case '-': res = a.minus(b); break;
        case '*': res = a.times(b); break;
        case '/':
          if (b.eq(0)) { res = Big(0); } // védjük a zéró osztást: 0 eredmény
          else { res = a.div(b); }
          break;
      }
      st.push(res);
    } else {
      throw new Error(`Invalid RPN token: ${t}`);
    }
  }
  if (st.length !== 1) {
    throw new Error('Invalid expression (stack not reduced to single value)');
  }
  return st[0];
}

/** ----- Közmű: szám tisztítás Big-hez ----- */
function toBigOrZero(value) {
  if (value == null || value === '') return Big(0);
  const clean = String(value).replace(/[^0-9.\-]/g, '') || '0';
  try { return Big(clean); } catch { return Big(0); }
}

/**
 * @param {Array<Object>} records — forrásadatok
 * @param {Object} processConfig
 * @param {Object} processConfig.fieldMapping — { forrásMező: célKulcs, … }
 * @param {string} [processConfig.pricingFormula] — pl. "{basePrice}*{discount}*{priceMargin}*{vat}"
 * @param {number} [processConfig.rounding] — kerekítési egység, pl. 10
 * @param {boolean} [processConfig.convertCurrency] — devizakonverzió bekapcsolása
 * @param {string} [processConfig.targetCurrency] — céldeviza kód, pl. 'HUF'
 * @param {number} [processConfig.discount] — UI %-ban (pl. 10 = 10%)
 * @param {number} [processConfig.priceMargin] — UI %-ban (pl. 20 = 20%)
 * @param {number} [processConfig.vat] — UI %-ban (pl. 27 = 27%)
 * @param {number} [processConfig.stockThreshold] — készletküszöb; ez alatt nem rendelhető
 * @returns {Promise<Array<Object>>}
 */
async function transformData(records, processConfig) {
  const {
    fieldMapping,
    stockThreshold = 1,
    pricingFormula,
    rounding = 1,
    convertCurrency: doConvert = false,
    targetCurrency = 'HUF',
    discount = 0,
    priceMargin = 0,
    vat = 0,
  } = processConfig;

  // Először keressük meg a price-hoz tartozó forrás kulcsot
  const baseKey = Object.entries(fieldMapping).find(([, dst]) => dst === 'price')?.[0] || null;

  const transformedList = await Promise.all(
    records.map(async (record) => {
      const transformed = {};

      // 1) Általános mező-mapping (kivéve price — azt külön számoljuk)
      for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
        if (dstKey !== 'price') {
          transformed[dstKey] = record[srcKey];
        }
      }

      // 2) Alapár olvasása
      const basePrice = baseKey ? toBigOrZero(record[baseKey]) : Big(0);

      // 3) % → szorzó előállítása
      const discountFactor = Big(1).minus(Big(discount).div(100));     // pl. 10% → 0.90
      const marginFactor   = Big(1).plus(Big(priceMargin).div(100));   // pl. 20% → 1.20
      const vatFactor      = Big(1).plus(Big(vat).div(100));           // pl. 27% → 1.27

      // 4) Képlet kiértékelése (ha van), különben fallback: csak basePrice
      let price = basePrice;
      if (pricingFormula) {
        try {
          price = evalFormula(pricingFormula, {
            basePrice,
            discount: discountFactor,
            priceMargin: marginFactor,
            vat: vatFactor,
          });
        } catch (e) {
          // Ha a képlet hibás, biztonságos fallback: basePrice
          // (Esetleg ide tehető logolás is.)
          price = basePrice;
        }
      }

      // 5) Devizakonverzió (ha be van kapcsolva)
      if (doConvert && targetCurrency) {
        try {
          const converted = await convertCurrency(price.toNumber(), targetCurrency);
          price = Big(converted);
        } catch (e) {
          // Árfolyam hiba esetén hagyjuk az eredeti árát (fallback)
        }
      }

      // 6) Kerekítés megadott egységre (1/10/100/...)
      //   - előbb egészre kerekítünk (half-up), majd egységre kerekítés
      const rounded = price
        .round(0, Big.roundHalfUp)   // egészre
        .div(rounding)               // osztás egységre
        .round(0, Big.roundHalfUp)   // egészre kerekítés
        .times(rounding);            // visszaszorzás egységre

      transformed.price = rounded.toString();

      // 7) Készletküszöb logika
      const stockSrcKey = Object.entries(fieldMapping).find(([, dst]) => {
        const v = String(dst || '').toLowerCase();
        return (
          v === 'stock' ||
          v.includes('stock') ||
          v.includes('készlet') ||
          v.includes('quantity') ||
          v === 'qty'
        );
      })?.[0];

      if (stockSrcKey) {
        // feed készlet normalizálása
        const rawStock = record[stockSrcKey];
        let feedStock = 0;
        if (rawStock != null && rawStock !== '') {
          const n = Number(String(rawStock).replace(',', '.').trim());
          feedStock = Number.isFinite(n) ? n : 0;
        }

        const below = Number.isFinite(stockThreshold) ? feedStock < stockThreshold : false;

        if (below) {
          // Küszöb alatt: 0 készlet + rendelhetőség tiltása
          transformed.stock = 0;
          transformed.orderable = false; // igazítsd az UNAS adapteredhez
          // transformed.status = 'inactive';
        } else {
          transformed.stock = feedStock;
          transformed.orderable = true;
        }
      }

      return transformed;
    })
  );

  return transformedList;
}

module.exports = transformData;
