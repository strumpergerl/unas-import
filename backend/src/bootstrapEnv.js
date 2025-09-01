// backend/src/bootstrapEnv.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function tryLoadEnv(file) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: true });
    console.log(`[ENV] Loaded: ${file} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
    return true;
  }
  return false;
}

(function ensureEnv() {
  const NODE_ENV = process.env.NODE_ENV || 'development';

  // lehetséges helyek (mindig a repo gyökér a prioritás)
  const repoRoot = path.resolve(__dirname, '..', '..'); // <repo>/
  const candidates = [
    path.join(repoRoot, `.env.${NODE_ENV}`),
    path.join(repoRoot, '.env'),
    path.resolve(process.cwd(), `.env.${NODE_ENV}`),
    path.resolve(process.cwd(), '.env'),
  ];

  let loaded = false;
  for (const file of candidates) {
    if (tryLoadEnv(file)) { loaded = true; break; }
  }

  if (!loaded) {
    console.warn('[ENV] WARN: nem találtam .env fájlt.');
    console.warn(`[ENV] CWD: ${process.cwd()}  __dirname: ${__dirname}`);
  }
})();
