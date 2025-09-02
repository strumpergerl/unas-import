// backend/src/runner.js
const { sendNotification } = require('./mailer');
const downloadFile = require('./core/downloadFile');
const parseData = require('./core/parseData');
const transformData = require('./core/transformData');
const uploadToUnas = require('./core/uploadToUnas');
const { db } = require('./db/firestore');

const logs = [];

/**
 * Egy folyamat futtatása Firestore config alapján
 */
async function runProcessById(processId) {
  try {
    // 1) Process config beolvasása Firestore-ból
    const procSnap = await db.collection('processes').doc(String(processId)).get();
    if (!procSnap.exists) {
      throw new Error(`Process not found in Firestore: ${processId}`);
    }
    const proc = { processId: procSnap.id, ...procSnap.data() };

    // 2) Shop config beolvasása Firestore-ból
    const shopSnap = await db.collection('shops').doc(String(proc.shopId)).get();
    if (!shopSnap.exists) {
      throw new Error(`Shop not found in Firestore: ${proc.shopId}`);
    }
    const shop = { shopId: shopSnap.id, ...shopSnap.data() };

    logs.push(`${new Date().toISOString()} - ${proc.displayName || proc.processId} start`);

    // 3) Feed letöltés
    const buf = await downloadFile(proc.feedUrl);

    // 4) Feldolgozás
    const recs = await parseData(buf, proc);
    const trans = await transformData(recs, proc);

    // 5) Feltöltés (ha nem dryRun)
    if (!proc.dryRun) {
      await uploadToUnas(trans, proc, shop);
    }

    logs.push(`Futtatás kész${proc.dryRun ? ' (dryRun)' : ''}`);
  } catch (err) {
    logs.push(`Hiba: ${err.message}`);
    console.error(`[RUNNER] runProcessById error:`, err);
    try {
      await sendNotification(`Hiba a folyamat futtatásakor`, err.message || String(err));
    } catch (notifyErr) {
      console.error('[RUNNER] Notification send failed:', notifyErr);
    }
  }
}

function getLogs() {
  return logs;
}

module.exports = { runProcessById, getLogs };
