// backend/src/scheduler.js
require('./bootstrapEnv');
const cron = require('node-cron'); // csak a napi prune-hoz
const { db } = require('./db/firestore');
const { runProcessById, pruneOldRuns } = require('./runner');

/** "30m", "3h", "1d", "45s" → ms */
function parseFrequencyToMs(freq) {
  if (!freq || typeof freq !== 'string') return null;
  const m = freq.trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n * mult;
}

/** Következő futás a referencia-időre horgonyozva (mindig a többszörösre kerekít) */
function nextFromReference(referenceAt, intervalMs, now = new Date()) {
  const ref = new Date(referenceAt || Date.now());
  if (!intervalMs || intervalMs <= 0 || Number.isNaN(ref.getTime())) return null;
  const diff = now.getTime() - ref.getTime();
  if (diff < 0) return ref; // jövőbeli referencia → első futás a ref időpontban
  const steps = Math.floor(diff / intervalMs) + 1;
  return new Date(ref.getTime() + steps * intervalMs);
}

/** kis jitter a thundering herd ellen (0..4s) */
function withJitter(date, maxMs = 4000) {
  const jitter = Math.floor(Math.random() * maxMs);
  return new Date(date.getTime() + jitter);
}

const timers = new Map();   // processId -> Timeout
const running = new Set();  // processId (fut épp)
let unsubscribe = null;

function cancelTimer(id) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function cancelAll() {
  for (const id of Array.from(timers.keys())) cancelTimer(id);
}

async function scheduleOne(docId, data, docRef) {
  cancelTimer(docId);
  if (!data?.enabled) return;

  const intervalMs = parseFrequencyToMs(data.frequency);
  if (!intervalMs) {
    console.warn(`[SCHED] ${docId}: érvénytelen frequency:`, data.frequency);
    return;
  }

  // ha hiányzik a referenceAt, most állítsuk be (horgony = most)
  let refAt = data.referenceAt ? new Date(data.referenceAt) : new Date();
  if (!data.referenceAt) {
    try { await docRef.update({ referenceAt: refAt.toISOString() }); }
    catch (e) { console.warn(`[SCHED] ${docId}: referenceAt írás hiba:`, e?.message); }
  }

  const now = new Date();
  const next = nextFromReference(refAt, intervalMs, now);
  if (!next) return;

  const nextJ = withJitter(next);
  const delay = Math.max(100, nextJ.getTime() - now.getTime());

  try { await docRef.update({ nextRunAt: next.toISOString() }); } catch {}

  const tick = async () => {
    const start = new Date();

    if (running.has(docId)) {
      console.warn(`[SCHED] ${docId}: még fut az előző példány, kihagyom ezt az időpontot.`);
    } else {
      running.add(docId);
      try {
        try { await docRef.update({ lastRunAt: start.toISOString() }); } catch {}
        await runProcessById(docId);
      } catch (e) {
        console.error(`[SCHED] ${docId}: futási hiba:`, e?.message || e);
      } finally {
        running.delete(docId);
      }
    }

    // Következő időpont kiszámítása: mindig a referencia-idő sorára illesztve
    const now2 = new Date();
    const next2 = nextFromReference(refAt, intervalMs, now2);
    const next2J = withJitter(next2);
    const delay2 = Math.max(100, next2J.getTime() - now2.getTime());

    try { await docRef.update({ nextRunAt: next2.toISOString() }); } catch {}
    timers.set(docId, setTimeout(tick, delay2));
  };

  timers.set(docId, setTimeout(tick, delay));
}

function watchAndSchedule() {
  if (unsubscribe) return;
  unsubscribe = db.collection('processes').onSnapshot((snap) => {
    const seen = new Set();
    snap.forEach((doc) => {
      const data = doc.data() || {};
      seen.add(doc.id);
      scheduleOne(doc.id, data, doc.ref).catch((e) =>
        console.error(`[SCHED] ${doc.id}: schedule hiba:`, e?.message || e)
      );
    });
    // törölt / nem látott processzek időzítőit leállítjuk
    for (const id of Array.from(timers.keys())) {
      if (!seen.has(id)) cancelTimer(id);
    }
  }, (err) => {
    console.error('[SCHED] Firestore snapshot hiba:', err?.message || err);
  });
}

function start() {
  watchAndSchedule();
  // napi prune 03:30 Europe/Budapest
  cron.schedule('30 3 * * *', () => {
    pruneOldRuns(30).catch(e => console.error('[SCHED] prune hiba:', e?.message || e));
  }, { timezone: 'Europe/Budapest' });
  console.log('[SCHED] referencia-idő alapú ütemező fut (setTimeout + Firestore).');
}

function stop() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  cancelAll();
  console.log('[SCHED] leállítva.');
}

module.exports = { start, stop, nextFromReference, parseFrequencyToMs };
