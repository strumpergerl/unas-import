// backend/src/shared/cache.js
function createTTLCache(ttlMs = 60 * 60 * 1000) {
  const CACHE = new Map();
  return {
    get(key) {
      const hit = CACHE.get(key);
      if (!hit) return null;
      if (Date.now() - hit.ts > ttlMs) { CACHE.delete(key); return null; }
      return hit.value;
    },
    set(key, value) { CACHE.set(key, { value, ts: Date.now() }); },
    delete(key) { CACHE.delete(key); },
    clear() { CACHE.clear(); }
  };
}
module.exports = { createTTLCache };
