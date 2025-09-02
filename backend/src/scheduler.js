// backend/src/scheduler.js
const cron = require('node-cron');
const { runProcessById, pruneOldRuns } = require('./runner');
const { db } = require('./db/firestore');

const activeJobs = new Map();

/**
 * frequency mezőből cron kifejezés
 * pl. '30m','3h','1d' -> cron string
 */
function cronExpression(freq) {
  const num = parseInt(freq.slice(0, -1), 10);
  const unit = freq.slice(-1);
  switch (unit) {
    case 'm': return `*/${num} * * * *`;
    case 'h': return `0 */${num} * * *`;
    case 'd': return `0 0 */${num} * *`;
    default: throw new Error(`Unsupported frequency: ${freq}`);
  }
}

/**
 * Egyetlen process ütemezése
 */
function scheduleProcess(proc) {
  if (!proc.frequency) {
    console.warn(`[SCHEDULER] Nincs frequency a process-ben: ${proc.processId}`);
    return;
  }

  try {
    const expr = cronExpression(proc.frequency);

    // Ha már van job erre a processId-ra, töröljük
    if (activeJobs.has(proc.processId)) {
      activeJobs.get(proc.processId).stop();
      activeJobs.delete(proc.processId);
    }

    const job = cron.schedule(expr, () => {
      console.log(`[SCHEDULER] Ütemezett futtatás: ${proc.displayName || proc.processId}`);
      runProcessById(proc.processId);
    });

    activeJobs.set(proc.processId, job);
    console.log(`[SCHEDULER] Ütemezve: ${proc.displayName || proc.processId} (${expr})`);
  } catch (err) {
    console.error(`[SCHEDULER] Nem sikerült ütemezni ${proc.processId}:`, err.message);
  }
}

async function scheduleProcesses() {
  try {
    // 1) jelenlegi process list betöltése
    const snap = await db.collection('processes').get();
    const processes = snap.docs.map(d => ({ processId: d.id, ...d.data() }));
    // 2) ütemezés
    rescheduleAll(processes);
    // 3) élő figyelés változásokra
    watchProcesses();
    console.log('[SCHEDULER] scheduleProcesses kész');
  } catch (err) {
    console.error('[SCHEDULER] scheduleProcesses hiba:', err?.message || err);
  }
}

/**
 * Összes process újraütemezése (pl. Firestore snapshot után)
 */
function rescheduleAll(processes) {
  // minden régi job leállítása
  for (const job of activeJobs.values()) {
    job.stop();
  }
  activeJobs.clear();

  // új ütemezés
  processes.forEach(scheduleProcess);
  console.log(`[SCHEDULER] ${processes.length} process ütemezve`);
}

/**
 * Napi egyszeri log prune ütemezése
 * (30 napnál régebbi run-ok törlése)
 * */

function scheduleLogPrune() {
  // Minden nap 03:30-kor
  cron.schedule('30 3 * * *', async () => {
    try {
      const deleted = await pruneOldRuns(30);
      if (deleted) {
        console.log(`[SCHEDULER] Log prune: ${deleted} régi run törölve`);
      }
    } catch (e) {
      console.error('[SCHEDULER] Log prune hiba:', e?.message || e);
    }
  }, { timezone: 'Europe/Budapest' });
}

/**
 * Firestore figyelése változásokra
 */
function watchProcesses() {
  db.collection('processes').onSnapshot((snap) => {
    const processes = snap.docs.map(d => ({ processId: d.id, ...d.data() }));
    rescheduleAll(processes);
  });
}

module.exports = { scheduleProcess, rescheduleAll, watchProcesses, scheduleLogPrune, scheduleProcesses };
