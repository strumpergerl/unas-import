// backend/db/migrate-config.js
const { db } = require('./firestore');
const shops = require('../config/shops.json');
const processes = require('../config/processes.json');

async function main() {
  const batch = db.batch();

  shops.forEach(s => {
    const ref = db.collection('shops').doc(String(s.shopId));
    batch.set(ref, { name: s.name, apiKey: s.apiKey });
  });

  processes.forEach(p => {
    const ref = db.collection('processes').doc(String(p.processId));
    const { processId, ...data } = p;
    batch.set(ref, data);
  });

  await batch.commit();
  console.log('Migráció kész ✅');
}

main().catch(e => { 
  console.error(e); 
  process.exit(1); 
});
