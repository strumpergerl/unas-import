// backend/src/bootstrapEnv.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function findEnv(startDir, envFile) {
  // Felfelé sétál a fájlrendszerben, amíg talál .env-t vagy .env.{NODE_ENV}-et
  let dir = startDir;
  for (let i = 0; i < 6; i++) { // max 6 szint
    const p = path.join(dir, envFile);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 1) Döntsük el, melyik env fájlt keressük
const nodeEnv = process.env.NODE_ENV || 'development';
const prioritized = [`.env.${nodeEnv}`, '.env.local', '.env']; 
// sorrend: .env.development vagy .env.production → .env.local → .env

let candidate = null;
for (const fname of prioritized) {
  candidate = findEnv(__dirname, fname) || findEnv(process.cwd(), fname);
  if (candidate) break;
}

if (candidate) {
  dotenv.config({ path: candidate });
  console.log(`[ENV] Loaded: ${candidate} (NODE_ENV=${nodeEnv})`);
} else {
  console.warn('[ENV] WARN: nem találtam .env fájlt.');
  console.warn('[ENV] CWD:', process.cwd(), ' __dirname:', __dirname);
}
