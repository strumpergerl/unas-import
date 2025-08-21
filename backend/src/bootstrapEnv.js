// backend/src/bootstrapEnv.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function findEnv(startDir) {
  // Felfelé sétál a fájlrendszerben, amíg talál .env-t
  let dir = startDir;
  for (let i = 0; i < 6; i++) { // max 6 szint
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const fromDirname = findEnv(__dirname);         // pl. backend/src -> gyökér
const fromCwd     = findEnv(process.cwd());     // ha máshonnan indítod
const candidate   = fromDirname || fromCwd;

if (candidate) {
  dotenv.config({ path: candidate });
  console.log(`[ENV] Loaded: ${candidate}`);
} else {
  console.warn('[ENV] WARN: .env nem található egyik szinten sem (indulási könyvtárhoz képest).');
  // ideiglenes diagnosztika:
  console.warn('[ENV] CWD:', process.cwd(), ' __dirname:', __dirname);
}
