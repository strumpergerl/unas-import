// backend/src/utils/key.js
function canonicalizeKey(raw, { caseSensitive = true } = {}) {
  if (raw == null) return '';
  const s = String(raw).trim();
  return caseSensitive ? s : s.toLowerCase();
}

module.exports = { canonicalizeKey };
