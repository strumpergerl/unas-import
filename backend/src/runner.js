// backend/src/runner.js
const { sendNotification } = require('./mailer');
const downloadFile = require('./core/downloadFile');
const parseData = require('./core/parseData');
const transformData = require('./core/transformData');
const uploadToUnas = require('./core/uploadToUnas');
const { db, admin } = require('./db/firestore');

/** Helper: Firestore Timestamp a Date/ISO-ból */
const toTs = (d) =>
	d instanceof admin.firestore.Timestamp
		? d
		: admin.firestore.Timestamp.fromDate(new Date(d));

/** Régi futások törlése finishedAtTs alapján (alap: 30 nap) */
async function pruneOldRuns(maxAgeDays = 30) {
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
	const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);
	let deleted = 0;

	for (;;) {
		const snap = await db
			.collection('runs')
			.where('finishedAtTs', '<', cutoffTs)
			.orderBy('finishedAtTs', 'asc')
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

/** Futás log beszúrása */
async function addRun(run) {
	const docId = run.id || `${run.processId || 'proc'}_${run.startedAt}`;
	const ref = db.collection('runs').doc(docId);

	// Gondoskodunk a Timestamp mezőkről
	const startedAtTs = run.startedAtTs || toTs(run.startedAt);
	const finishedAtTs =
		run.finishedAtTs || (run.finishedAt ? toTs(run.finishedAt) : null);

	const payload = {
		...run,
		startedAtTs,
		...(finishedAtTs ? { finishedAtTs } : {}),
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
	};

	try {
		await ref.set(payload, { merge: false });
		console.log(`[RUNS] Mentve: runs/${docId}`);
	} catch (e) {
		console.error('[RUNS] Firestore írás HIBA:', e?.message || e);
		throw e; // jelezzük a hívónak is
	}

	// Nem kritikus: rotáció
	try {
		const deleted = await pruneOldRuns(14);
		if (deleted) console.log(`[RUNS] Rotáció: ${deleted} régi log törölve`);
	} catch (e) {
		console.warn('[RUNS] Rotáció hiba:', e?.message || e);
	}
}

/** Legutóbbi futások lekérése (Timestamp szerint, fallback createdAt) */
async function getLogs(limit = 100) {
	try {
		const snap = await db
			.collection('runs')
			.orderBy('startedAtTs', 'desc')
			.limit(limit)
			.get();
		return snap.docs.map((d) => d.data());
	} catch (e) {
		console.warn('[RUNS] getLogs fallback createdAt-re:', e?.message || e);
		const snap = await db
			.collection('runs')
			.orderBy('createdAt', 'desc')
			.limit(limit)
			.get();
		return snap.docs.map((d) => d.data());
	}
}

/** Egy folyamat futtatása és logolása */
async function runProcessById(processId) {
	const startedAt = new Date();
	const run = {
		id: `${processId}_${startedAt.toISOString()}`,
		processId,
		processName: null,
		shopId: null,
		shopName: null,
		startedAt: startedAt.toISOString(),
		startedAtTs: admin.firestore.Timestamp.fromDate(startedAt),
		finishedAt: null,
		finishedAtTs: null,
		durationMs: null,
		dryRun: true, // default, később felülírjuk
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
		// Process + Shop betöltés Firestore-ból
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
		run.dryRun = !!proc.dryRun;

		// 1) Download
		const t1 = Date.now();
		const buf = await downloadFile(proc.feedUrl);
		const t2 = Date.now();

		// 2) Parse
		const recs = await parseData(buf, proc);
		const t3 = Date.now();

		// 3) Transform
		const trans = await transformData(recs, proc);
		const t4 = Date.now();

		run.counts.input = Array.isArray(recs) ? recs.length : 0;
		run.counts.output = Array.isArray(trans) ? trans.length : 0;

		// 4) Upload (ha nem dryRun)
		let stats = {
			modified: [],
			skippedNoKey: [],
			skippedNotFound: [],
			failed: [],
			dryRun: true,
		};

		const t5 = Date.now();
		if (!proc.dryRun) {
			stats = await uploadToUnas(trans, proc, shop);
		}
		const t6 = Date.now();

		run.counts.modified = stats.modified?.length || 0;
		run.counts.skippedNoKey = stats.skippedNoKey?.length || 0;
		run.counts.skippedNotFound = stats.skippedNotFound?.length || 0;
		run.counts.failed = stats.failed?.length || 0;

		// Items (óvatosan a méretekkel – Firestore 1MB/doc limit!)
		for (const m of stats.modified || []) {
			run.items.push({
				key: m.key ?? null,
				sku: m.sku ?? null,
				action: 'modify',
				changes: m.changes || {},
				// Ha túl nagy lenne, itt érdemes lehet csak kivonatot menteni:
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
		} catch {
			// némán tovább
		}
	} finally {
		const finished = new Date();
		run.finishedAt = finished.toISOString();
		run.finishedAtTs = admin.firestore.Timestamp.fromDate(finished);
		run.durationMs = finished - new Date(run.startedAt);

		try {
			await addRun(run);
		} catch (e) {
			console.error('[runner.addRun] hiba:', e?.message || e);
		}
	}
}

module.exports = { runProcessById, getLogs, addRun, pruneOldRuns };
