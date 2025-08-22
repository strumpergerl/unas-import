// backend/src/core/transformData.js
const Big = require('big.js');
const { convertCurrency } = require('../utils/currencyConverter');

function applyPricing(base, formula, rounding = 1) {
	// formula pl: "base*0.88*1.20*1.27" vagy "base*0.9+500"
	let expr = formula.replace(/\bbase\b/g, base.toString());
	// Biztonságos „mini-parser”: csak számok, ., + - * / és whitespace engedett
	if (!/^[\d\.\s+\-*/]+$/.test(expr))
		throw new Error('Érvénytelen pricingFormula');
	// Big.js-al kiértékelés: bonts operátorokra/számokra
	const tokens = expr.match(/(\d+(?:\.\d+)?|[+\-*/])/g);
	let acc = Big(tokens.shift());
	while (tokens.length) {
		const op = tokens.shift();
		const val = Big(tokens.shift());
		if (op === '+') acc = acc.plus(val);
		else if (op === '-') acc = acc.minus(val);
		else if (op === '*') acc = acc.times(val);
		else if (op === '/') acc = acc.div(val);
	}
	if (rounding > 1) {
		// 100-as kerekítés: 12345 -> 12300 stb.
		acc = acc.div(rounding).round(0, 0).times(rounding);
	} else {
		acc = acc.round(0, 0); // 0 decimális, lefelé/kereskedelmi szabály szerint
	}
	return acc;
}

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
	const baseKey =
		Object.entries(fieldMapping).find(([, dst]) => dst === 'price')?.[0] ||
		null;

	const transformedList = await Promise.all(
		records.map(async (record) => {
			const transformed = {};

      for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
        const dst = String(dstKey || '').toLowerCase();
        // 'price' és 'stock' külön kerül kiszámításra/normalizálásra később
        if (dst === 'price' || dst === 'stock') continue;
        transformed[dst] = record[srcKey];
      }

			const basePrice = baseKey ? toBigOrZero(record[baseKey]) : Big(0);

			const discountFactor = Big(1).minus(Big(discount).div(100)); // pl. 10% → 0.90
			const marginFactor = Big(1).plus(Big(priceMargin).div(100)); // pl. 20% → 1.20
			const vatFactor = Big(1).plus(Big(vat).div(100)); // pl. 27% → 1.27

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
					const converted = await convertCurrency(
						price.toNumber(),
						processConfig.currency, // forrás deviza a processből
						targetCurrency // cél deviza
					);
					price = Big(converted);
				} catch (e) {
					// Árfolyam hiba esetén hagyjuk az eredeti árát (fallback)
          
				}
			}

			// 6) Kerekítés megadott egységre (1/10/100/...)
			//   - előbb egészre kerekítünk (half-up), majd egységre kerekítés
      if (price.lte(0)) {
        console.warn('[PRICE-DEBUG] Nem pozitív ár a kerekítés előtt, fallback basePrice-re');
        price = basePrice;
      }

			let rounded;
			if (rounding > 1) {
				// felfelé a legközelebbi többszörösre, hogy ne nullázódjon
				rounded = price.div(rounding).round(0, Big.roundUp).times(rounding);
			} else {
				rounded = price.round(0, Big.roundHalfUp);
			}
			if (rounded.lte(0)) rounded = Big(1); // védelem
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
        if (rawStock !== undefined && rawStock !== null && rawStock !== '') {
          const cleaned = String(rawStock)
            .replace(',', '.')
            .replace(/[^0-9.\-]/g, '')  // csak szám/jel maradjon
            .trim();
          const n = Number(cleaned);
          feedStock = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
        }

        // Küszöb kezelés: ha kisebb, akkor legyen 0
        if (Number.isFinite(stockThreshold) && feedStock < stockThreshold) {
          feedStock = 0;
        }

        transformed.stock = feedStock;
        transformed.orderable = feedStock > 0;
        // transformed.status = feedStock > 0 ? 'active' : 'inactive';
      }

			return transformed;
		})
	);

	return transformedList;
}

module.exports = transformData;
