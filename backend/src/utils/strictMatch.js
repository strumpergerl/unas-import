// backend/src/matchers/strictMatch.js
const { canonicalizeKey } = require('../utils/key');

function matchByExactKey(feedRow, indexMap, feedKeyField, { caseSensitive = true } = {}) {
  const feedKey = feedRow?.[feedKeyField];
  const key = canonicalizeKey(feedKey, { caseSensitive });
  const entry = key ? indexMap.get(key) : undefined;

  return { feedKey, key, entry };
}

module.exports = { matchByExactKey };
