// backend/src/matchers/strictMatch.js
const { canonicalizeKey } = require('../utils/key');

function matchByExactKey(feedRow, indexMap, feedKeyField, { caseSensitive = true } = {}) {
  const keyRaw = feedRow?.[feedKeyField];
  const key = canonicalizeKey(keyRaw, { caseSensitive });
  const entry = key ? indexMap.get(key) : undefined;

  return { keyRaw, key, entry };
}

module.exports = { matchByExactKey };
