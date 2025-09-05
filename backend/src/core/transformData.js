// backend/src/core/transformData.js
const Big = require('big.js');
const { convertCurrency } = require('../utils/currencyConverter');

function evalFormula(formula, values) {
	if (!formula || typeof formula !== 'string') {
		throw new Error('pricingFormula is empty or not a string');
	}

	// 1) Tokenizálás
	const tokens = tokenize(formula);

	// 2) Tokenek validálása és helyettesítés Big értékekre / operátorokra
	const normalized = tokens
		.map((t) => {
			if (isWhitespace(t)) return null; // elhagyjuk
			if (isNumber(t)) return Big(t);
			if (isOperator(t) || isParen(t)) return t;

			switch (t) {
				case '{basePrice}':
					return values.basePrice;
				case '{discount}':
					return values.discount;
				case '{priceMargin}':
					return values.priceMargin;
				case '{vat}':
					return values.vat;
				default:
					throw new Error(`Unknown token in pricingFormula: ${t}`);
			}
		})
		.filter(Boolean);

	const rpn = toRPN(normalized);

	return evalRPN(rpn);
}

/** ----- Segédfüggvények a képlet kiértékeléséhez ----- */

function tokenize(text) {
	// {basePrice} | {discount} | {priceMargin} | {vat} | szám | operátor | zárójel | whitespace
	const re =
		/(\{basePrice\}|\{discount\}|\{priceMargin\}|\{vat\}|\d+(?:\.\d+)?|[+\-*/()]|\s+)/g;
	const raw = text.match(re);
	if (!raw) {
		throw new Error('pricingFormula contains no valid tokens');
	}
	return raw;
}
function isWhitespace(t) {
	return /^\s+$/.test(t);
}
function isNumber(t) {
	return /^\d+(?:\.\d+)?$/.test(String(t));
}
function isOperator(t) {
	return t === '+' || t === '-' || t === '*' || t === '/';
}
function isParen(t) {
	return t === '(' || t === ')';
}
function precedence(op) {
	return op === '+' || op === '-' ? 1 : op === '*' || op === '/' ? 2 : 0;
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
				if (top === '(') {
					found = true;
					break;
				}
				out.push(top);
			}
			if (!found) throw new Error('Mismatched parentheses in pricingFormula');
		} else {
			throw new Error(`Invalid token during RPN conversion: ${t}`);
		}
	}
	while (stack.length) {
		const top = stack.pop();
		if (top === '(' || top === ')')
			throw new Error('Mismatched parentheses in pricingFormula');
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
				case '+':
					res = a.plus(b);
					break;
				case '-':
					res = a.minus(b);
					break;
				case '*':
					res = a.times(b);
					break;
				case '/':
					if (b.eq(0)) {
						res = Big(0);
					} // védjük a zéró osztást: 0 eredmény
					else {
						res = a.div(b);
					}
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

function toBigOrZero(value) {
	if (value == null || value === '') return Big(0);
	const clean = String(value).replace(/[^0-9.\-]/g, '') || '0';
	try {
		return Big(clean);
	} catch {
		return Big(0);
	}
}

function hasVatInFormula(formula) {
  return typeof formula === 'string' && /\{vat\}/.test(formula);
}

function roundToUnit(bigVal, unit = 1) {
  if (!bigVal || bigVal.lte(0)) return Big(0);
  if (unit > 1) {
    // fogyasztói áraknál jellemző: felfelé a legközelebbi egységre
    return bigVal.div(unit).round(0, Big.roundUp).times(unit);
  }
  return bigVal.round(0, Big.roundHalfUp);
}

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

  console.log('[Transforming data] with config:', {
	fieldMapping,
	stockThreshold,
	pricingFormula,

  });

  const baseKey = Object.entries(fieldMapping).find(([, dst]) => dst === 'price')?.[0] || null;

  const vatFactor = Big(1).plus(Big(vat).div(100));
  const discountFactor = Big(1).minus(Big(discount).div(100));
  const marginFactor   = Big(1).plus(Big(priceMargin).div(100));

  const formulaHasVat = hasVatInFormula(pricingFormula);

  const transformedList = await Promise.all(records.map(async (record) => {
    const transformed = {};

    // 1) Átlagos mezők másolása
    for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
      const dst = String(dstKey || '')
      if (dst === 'price' || dst === 'stock') continue;
      transformed[dst] = record[srcKey];
    }

    // 2) Alapár beolvasása
    const basePrice = baseKey ? toBigOrZero(record[baseKey]) : Big(0);

    // 3) Nettó/bruttó számítás
    let net = Big(0);
    let gross = Big(0);

    try {
      if (pricingFormula) {
        const val = evalFormula(pricingFormula, {
          basePrice,
          discount: discountFactor,
          priceMargin: marginFactor,
          vat: vatFactor,
        });
        if (formulaHasVat) {
          // A képlet bruttót ad → számoljuk vissza a nettót
          gross = val;
          net = vatFactor.eq(0) ? Big(0) : gross.div(vatFactor);
        } else {
          // A képlet nettót ad → ebből képezzük a bruttót
          net = val;
          gross = net.times(vatFactor);
        }
      } else {
        // Nincs képlet: nettó = basePrice * (1-discount) * (1+margin)
        net = basePrice.times(discountFactor).times(marginFactor);
        gross = net.times(vatFactor);
      }
    } catch {
      // Biztonságos fallback
      net = basePrice.times(discountFactor).times(marginFactor);
      gross = net.times(vatFactor);
    }

    // 4) Devizakonverzió (nettón), majd bruttó újraszámolása
    if (doConvert && targetCurrency) {
      try {
        const netConv = await convertCurrency(net.toNumber(), processConfig.currency, targetCurrency);
        net = Big(netConv);
        gross = net.times(vatFactor); // bruttó mindig nettóból
      } catch {
        console.warn('Currency conversion failed, using original prices');
		return;
      }
    }

    // 5) Kerekítés (nettó és bruttó külön)
    if (net.lte(0)) net = basePrice.gt(0) ? basePrice : Big(1);
    if (gross.lte(0)) gross = net.times(vatFactor);

    const netRounded   = roundToUnit(net,   rounding);
    const grossRounded = roundToUnit(gross, rounding);

    // 6) Kimeneti mezők
    transformed.price_net   = netRounded.toString();
    transformed.price_gross = grossRounded.toString();

    // Kompatibilitás: ha valahol csak "price" kell, tegyük a bruttót
    transformed.price = transformed.price_gross;

    // 7) Készlet normalizálás + küszöb
    const stockSrcKey = Object.entries(fieldMapping).find(([, dst]) => {
      const v = String(dst || '').toLowerCase();
      return v === 'stock' || v.includes('stock') || v.includes('készlet') || v.includes('quantity') || v === 'qty';
    })?.[0];

    if (stockSrcKey) {
      const raw = record[stockSrcKey];
      let feedStock = 0;
      if (raw !== undefined && raw !== null && raw !== '') {
        const cleaned = String(raw).replace(',', '.').replace(/[^0-9.\-]/g, '').trim();
        const n = Number(cleaned);
        feedStock = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
      }
      // Ha a feedben a készlet nagyobb, mint a küszöb, csak a "Vásárolható, ha nincs Raktáron" mezőt állítjuk
      if (Number.isFinite(stockThreshold) && feedStock >= stockThreshold) {
        transformed.orderable = 1;
      } else {
		transformed.orderable = 0;
	  }
	}

    return transformed;
  }));

  return transformedList;
}

module.exports = transformData;
