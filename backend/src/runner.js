const { sendNotification } = require('./mailer');
const downloadFile = require('./core/downloadFile');
const parseData = require('./core/parseData');
const transformData = require('./core/transformData');
const uploadToUnas = require('./core/uploadToUnas');
const shops = require('./config/shops.json');
const processes = require('./config/processes.json');

const logs = [];

async function runProcessById(processId) {
  const proc = processes.find(p => p.processId === processId);
  const shop = shops.find(s => s.shopId === proc.shopId);
  try {
    logs.push(`${new Date().toISOString()} - ${proc.displayName} start`);
    const buf = await downloadFile(proc.feedUrl);
    const recs = await parseData(buf, proc.feedUrl);
    const trans = transformData(recs, proc);
    await uploadToUnas(trans, proc, shop);
    logs.push(`Futtatás kész${proc.dryRun ? ' (dryRun)' : ''}`);
  } catch (err) {
    logs.push(`Hiba: ${err.message}`);
    // Értesítés hiba esetén
    await sendNotification(`Hiba: ${proc.displayName}`, err.message);
  }
}

function getLogs() {
  return logs;
}

module.exports = { runProcessById, getLogs };