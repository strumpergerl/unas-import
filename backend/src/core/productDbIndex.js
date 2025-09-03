// backend/src/core/productDbIndex.js
const { canonicalizeKey } = require('../utils/key');

function buildProductDbIndex(rows, keyField, { caseSensitive = true } = {}) {
  const map = new Map();
  for (const row of rows || []) {
    const raw = row?.[keyField];
    const key = canonicalizeKey(raw, { caseSensitive });
    if (key) {
      map.set(key, row);
    }
  }
  return map;
}

module.exports = { buildProductDbIndex };
