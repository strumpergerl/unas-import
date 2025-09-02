// backend/src/runner.js
const { sendNotification } = require('./mailer');
const downloadFile = require('./core/downloadFile');
const parseData = require('./core/parseData');
const transformData = require('./core/transformData');
const uploadToUnas = require('./core/uploadToUnas');
const { db, admin } = require('./db/firestore');

async function pruneOldRuns(maxAgeDays = 30) {
	const cutoff = new Date(
		Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
	).toISOString();
	let deleted = 0;
	for (;;) {
		const snap = await db
			.collection('runs')
			.where('finishedAt', '<', cutoff)
			.orderBy('finishedAt', 'asc')
			.limit(450)
			.get();
		if (snap.empty) break;
		const batch = db.batch();
		snap.docs.forEach((doc) => batch.delete(doc.ref));
		await batch.commit();
		deleted += snap.size;
		if (snap.size < 450) break;
	}
	return deleted;
}

async function addRun(run) {
  const { db, admin } = require('./db/firestore');
  const docId = run.id || `${run.processId || 'proc'}_${run.startedAt}`;
  const ref = db.collection('runs').doc(docId);

  try {
    await ref.set(
      { ...run, createdAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: false }
    );
    console.log(`[RUNS] Mentve: runs/${docId}`);
  } catch (e) {
    console.error('[RUNS] Firestore írás HIBA:', e?.message || e);
    throw e; // ne nyeljük el, hogy a hívó is lássa
  }

  // Rotáció (nem kritikus, de logoljuk)
  try {
    const deleted = await pruneOldRuns(30);
    if (deleted) console.log(`[RUNS] Rotáció: ${deleted} régi log törölve`);
  } catch (e) {
    console.warn('[RUNS] Rotáció hiba:', e?.message || e);
  }
}

async function getLogs(limit = 100) {
  const { db } = require('./db/firestore');
  // Először startedAt szerint próbálunk, ha bármi gond, fallback createdAt-re
  try {
    const snap = await db.collection('runs')
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.warn('[RUNS] getLogs fallback createdAt-re:', e?.message || e);
    const snap = await db.collection('runs')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }
}

async function runProcessById(processId) {
	const startedAt = new Date();
	const run = {
		id: `${processId}_${startedAt.toISOString()}`,
		processId,
		processName: null,
		shopId: null,
		shopName: null,
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		durationMs: null,
		stages: { downloadMs: 0, parseMs: 0, transformMs: 0, uploadMs: 0 },
		counts: {
			input: 0,
			output: 0,
			modified: 0,
			skippedNoKey: 0,
			skippedNotFound: 0,
			failed: 0,
		},
		items: [],
		error: null,
	};

	try {
		const procSnap = await db
			.collection('processes')
			.doc(String(processId))
			.get();
		if (!procSnap.exists)
			throw new Error(`Process not found in Firestore: ${processId}`);
		const proc = { processId: procSnap.id, ...procSnap.data() };

		const shopSnap = await db
			.collection('shops')
			.doc(String(proc.shopId))
			.get();
		if (!shopSnap.exists)
			throw new Error(`Shop not found in Firestore: ${proc.shopId}`);
		const shop = { shopId: shopSnap.id, ...shopSnap.data() };
		run.processName = proc.displayName || proc.processId;
		run.shopId = shop.shopId;
		run.shopName = shop.name;

		const t1 = Date.now();
		const buf = await downloadFile(proc.feedUrl);
		const t2 = Date.now();

		const recs = await parseData(buf, proc);
		const t3 = Date.now();
		const trans = await transformData(recs, proc);
		const t4 = Date.now();

		run.counts.input = Array.isArray(recs) ? recs.length : 0;
		run.counts.output = Array.isArray(trans) ? trans.length : 0;

		let stats = {
			modified: [],
			skippedNoKey: [],
			skippedNotFound: [],
			failed: [],
			dryRun: true,
		};
		const t5 = Date.now();
		if (!proc.dryRun) stats = await uploadToUnas(trans, proc, shop);
		const t6 = Date.now();

		run.counts.modified = stats.modified?.length || 0;
		run.counts.skippedNoKey = stats.skippedNoKey?.length || 0;
		run.counts.skippedNotFound = stats.skippedNotFound?.length || 0;
		run.counts.failed = stats.failed?.length || 0;

		for (const m of stats.modified || []) {
			run.items.push({
				key: m.key ?? null,
				sku: m.sku ?? null,
				action: 'modify',
				changes: m.changes || {},
				before: m.before ?? null,
				after: m.after ?? null,
			});
		}
		for (const s of stats.skippedNoKey || []) {
			run.items.push({
				key: s.key ?? null,
				sku: null,
				action: 'skip',
				changes: {},
				before: null,
				after: null,
				error: s.reason || 'No key',
			});
		}
		for (const s of stats.skippedNotFound || []) {
			run.items.push({
				key: s.key ?? null,
				sku: null,
				action: 'skip',
				changes: {},
				before: null,
				after: null,
				error: s.reason || 'Not found',
			});
		}
		for (const f of stats.failed || []) {
			run.items.push({
				key: f.key ?? null,
				sku: f.sku ?? null,
				action: 'fail',
				changes: {},
				before: null,
				after: null,
				error: f.error || f.statusText || 'Failed',
			});
		}

		run.stages.downloadMs = t2 - t1;
		run.stages.parseMs = t3 - t2;
		run.stages.transformMs = t4 - t3;
		run.stages.uploadMs = t6 - t5;
	} catch (err) {
		run.error = err?.message || String(err);
		try {
			await sendNotification(`Hiba a folyamat futtatásakor`, run.error);
		} catch {}
	} finally {
		const finished = new Date();
		run.finishedAt = finished.toISOString();
		run.durationMs = finished - startedAt;
		try {
			await addRun(run);
		} catch (e) {
			console.error('[runner.addRun] hiba:', e?.message || e);
		}
	}
}

module.exports = { runProcessById, getLogs, addRun, pruneOldRuns };
