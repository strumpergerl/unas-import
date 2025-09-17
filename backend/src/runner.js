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

/** Régi futások törlése finishedAtTs alapján (alap: 7 nap) */
async function pruneOldRuns(maxAgeDays = 7) {
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
	const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);
	let deleted = 0;

	for (;;) {
		const snap = await db
			.collection('runs')
			.where('finishedAtTs', '<', cutoffTs)
			.orderBy('finishedAtTs', 'asc')
			.limit(25)
			.get();

		if (snap.empty) break;

		const batch = db.batch();
		snap.docs.forEach((doc) => batch.delete(doc.ref));
		await batch.commit();
		deleted += snap.size;

		if (snap.size < 25) break;
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

	const toProjected = (it) => ({
		sku: it?.sku ?? null,
		action: it?.action ?? null,
		changes: (it && typeof it.changes === 'object' && it.changes !== null) ? it.changes : {},
		error: it?.error ?? undefined
	});

	const itemsProjected = Array.isArray(run.items) ? run.items.map(toProjected) : [];

	const payload = {
		...run,
		items: itemsProjected, // ⬅️ csak sku/action/changes
		startedAtTs,
		...(finishedAtTs ? { finishedAtTs } : {}),
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
	};

	// Debug: mentendő adat mérete és tartalma
	try {
		const runSize = JSON.stringify(run).length;
		console.log(`[RUNS] Mentés előtt: run méret = ${runSize} byte, items = ${run.items.length}`);
		if (run.items.length > 0) {
			for (let i = 0; i < Math.min(3, run.items.length); i++) {
				console.log(`[RUNS] Item[${i}] teljes adat:`, JSON.stringify({
					sku: run.items[i].sku,
					action: run.items[i].action,
					changes: run.items[i].changes,
					error: run.items[i].error
				}, null, 2));
			}
		}
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
async function getLogs(limit = 25) {
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
	let resolvedApiKey = null;
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

		let shop = { shopId: shopSnap.id, ...shopSnap.data() };
		// apiKey placeholder feloldása, ha szükséges
		if (
			typeof shop.apiKey === 'string' &&
			shop.apiKey.startsWith('${') &&
			shop.apiKey.endsWith('}')
		) {
			const envVar = shop.apiKey.slice(2, -1);
			resolvedApiKey = process.env[envVar] || null;
			if (resolvedApiKey) {
				shop.apiKey = resolvedApiKey;
			}
		} else {
			resolvedApiKey = shop.apiKey;
		}

		// DEBUG LOG: processId, shopId, shop, apiKey resolved-e
		console.log('[RUNNER][DEBUG]', {
			processId,
			shopId: proc.shopId,
			shopDoc: {
				...shop,
				apiKey: resolvedApiKey ? '[RESOLVED]' : '[NOT RESOLVED]',
			},
		});

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

		run.items = [];

		for (const m of (stats.modified || [])) {
		run.items.push({
			sku: m.sku ?? null,
			action: 'modify',
			changes: m.changes ?? {}, 
			error: undefined
		});
		}

		for (const f of (stats.failed || [])) {
		run.items.push({
			sku: f.sku ?? null,
			action: 'fail',
			changes: f.changes ?? {},
			error: f.error || f.statusText || 'Failed'
		});
		}


		run.stages.downloadMs = t2 - t1;
		run.stages.parseMs = t3 - t2;
		run.stages.transformMs = t4 - t3;
		run.stages.uploadMs = t6 - t5;

		// --- EMAIL NOTIFICATION ---
		try {
			const procName = run.processName || processId;
			const shopName = run.shopName || '';
			const started = run.startedAt
				? new Date(run.startedAt).toLocaleString('hu-HU')
				: '';
			const finished = run.finishedAt
				? new Date(run.finishedAt).toLocaleString('hu-HU')
				: '';
			const duration = run.durationMs
				? `${Math.floor(run.durationMs / 60000)} perc ${Math.floor(
						(run.durationMs % 60000) / 1000
				  )} mp`
				: '';
			if (run.counts.failed > 0) {
				// Küldjünk emailt, ha van hibás tétel
				const subject = `⚠️ Hibás tételek a szinkronban - ${procName}`;
				const body = `
<div style="font-family:Arial,sans-serif;">
	<h2 style="color:#c62828;">Szinkron lefutott, de voltak hibás tételek</h2>
	<table style="border-collapse:collapse;">
		<tr><td><b>Shop:</b></td><td>${shopName}</td></tr>
		<tr><td><b>Folyamat:</b></td><td>${procName}</td></tr>
		<tr><td><b>Indult:</b></td><td>${started}</td></tr>
		<tr><td><b>Befejeződött:</b></td><td>${finished}</td></tr>
		<tr><td><b>Időtartam:</b></td><td>${duration}</td></tr>
		<tr><td><b>Módosított termékek:</b></td><td style="color:#1565c0;">${run.counts.modified}</td></tr>
		<tr><td><b>Hibás termékek:</b></td><td style="color:#c62828;">${run.counts.failed}</td></tr>
	</table>
	<br>
	<small style="color:#888;">Ez az email automatikusan generált értesítés.</small>
</div>
`;
				await sendNotification(subject, body);
			} else if (run.error) {
				// Sikertelen szinkron (általános hiba)
				const subject = `❌ Szinkron hiba - ${procName}`;
				const body = `
<div style="font-family:Arial,sans-serif;">
	<h2 style="color:#c62828;">Szinkron hiba történt</h2>
	<table style="border-collapse:collapse;">
		<tr><td><b>Shop:</b></td><td>${shopName}</td></tr>
		<tr><td><b>Folyamat:</b></td><td>${procName}</td></tr>
		<tr><td><b>Indult:</b></td><td>${started}</td></tr>
		<tr><td><b>Befejeződött:</b></td><td>${finished}</td></tr>
		<tr><td><b>Időtartam:</b></td><td>${duration}</td></tr>
		<tr><td><b>Hiba oka:</b></td><td style="color:#c62828;">${run.error}</td></tr>
	</table>
	<br>
	<small style="color:#888;">Ez az email automatikusan generált értesítés.</small>
</div>
`;
				await sendNotification(subject, body);
			}
		} catch (e) {
			console.warn('[RUNNER] Email notification error:', e?.message || e);
		}
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
