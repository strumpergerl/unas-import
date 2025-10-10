// backend/src/runner.js
const { sendNotification } = require('./mailer');
const downloadFile = require('./core/downloadFile');
const parseData = require('./core/parseData');
const transformData = require('./core/transformData');
const uploadToUnas = require('./core/uploadToUnas');
const { db, admin } = require('./db/firestore');
const { updateRates } = require('./utils/rateUpdater');

/** Helper: Firestore Timestamp a Date/ISO-ból */
const toTs = (d) =>
	d instanceof admin.firestore.Timestamp
		? d
		: admin.firestore.Timestamp.fromDate(new Date(d));

/** Régi futások törlése finishedAtTs alapján (alap: 7 nap) */
async function pruneOldRuns(maxAgeDays = 1) {
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

	const startedAtTs = run.startedAtTs || toTs(run.startedAt);
	const finishedAtTs =
		run.finishedAtTs || (run.finishedAt ? toTs(run.finishedAt) : null);

	// --> ÚJ: tömörítés
	const compact = compactRunForFirestore({ ...run, startedAtTs, finishedAtTs });

	const toProjected = (it) => ({
		sku: it?.sku ?? null,
		action: it?.action ?? null,
		changes:
			it && typeof it.changes === 'object' && it.changes !== null
				? it.changes
				: {},
		error: it?.error ?? null,
	});

	const itemsProjected = Array.isArray(run.items)
		? run.items.map(toProjected)
		: [];

	const payload = {
		...compact,
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
	};

	// Debug: mentendő adat mérete és tartalma
	try {
		const runSize = JSON.stringify(run).length;
		console.log(
			`[RUNS] Mentés előtt: run méret = ${runSize} byte, items = ${run.items.length}`
		);
		if (run.items.length > 0) {
			for (let i = 0; i < Math.min(3, run.items.length); i++) {
				console.log(
					`[RUNS] Item[${i}] teljes adat:`,
					JSON.stringify(
						{
							sku: run.items[i].sku,
							action: run.items[i].action,
							changes: run.items[i].changes,
							error: run.items[i].error,
						},
						null,
						2
					)
				);
			}
		}
		await ref.set(payload, { merge: false });
		console.log(`[RUNS] Mentve: runs/${docId}`);
	} catch (e) {
		console.error('[RUNS] Firestore írás HIBA:', e?.message || e);
		throw e;
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

/** Firestore dokumentum tömörítése a log számára **/

const SAFE_DOC_LIMIT = 1_000_000; // Firestore ~1MB limit körül biztonsági sáv
function compactRunForFirestore(run) {
	// 1) Minimális, kért tartalom
	const modifiedAll = (run.items || [])
		.filter((i) => i.action === 'modify')
		.map((i) => ({ sku: i.sku ?? null, changes: i.changes || {} }));

	const failedAll = (run.items || [])
		.filter((i) => i.action === 'fail')
		.map((i) => ({ sku: i.sku ?? null, error: i.error || 'Failed' }));

	const skipped = {
		noKey: Number(run.counts?.skippedNoKey || 0),
		notFound: Number(run.counts?.skippedNotFound || 0),
		total:
			Number(run.counts?.skippedNoKey || 0) +
			Number(run.counts?.skippedNotFound || 0),
	};

	// 2) Alap payload (mezők értékeit nem alakítjuk át)
	let payload = {
		id: run.id,
		processId: run.processId ?? null,
		processName: run.processName ?? null,
		shopId: run.shopId ?? null,
		shopName: run.shopName ?? null,
		startedAt: run.startedAt,
		startedAtTs: run.startedAtTs,
		finishedAt: run.finishedAt,
		finishedAtTs: run.finishedAtTs,
		durationMs: run.durationMs ?? null,
		dryRun: !!run.dryRun,
		stages: run.stages || {},
		counts: run.counts || {},
		error: run.error ?? null,

		// csak a kért listák:
		modified: modifiedAll,
		failed: failedAll,
		skipped,

		// meta infó a vágásról (kezdetben nincs vágás)
		meta: {
			modifiedTotal: modifiedAll.length,
			failedTotal: failedAll.length,
			modifiedStored: modifiedAll.length,
			failedStored: failedAll.length,
			truncated: false,
		},
	};

	// 3) Méretőr – ha túl nagy lenne, lépcsőzetesen vágunk a listák végéből
	const fits = (obj) => Buffer.byteLength(JSON.stringify(obj)) < SAFE_DOC_LIMIT;

	if (!fits(payload)) {
		// Először a modified listát kurtítjuk
		let lo = 0,
			hi = modifiedAll.length,
			keep = Math.min(hi, 1000);
		// bináris keresés szerű csökkentés
		while (keep >= 0) {
			payload.modified = modifiedAll.slice(0, keep);
			payload.meta.modifiedStored = payload.modified.length;
			payload.meta.truncated = true;
			if (fits(payload)) break;
			keep = keep > 50 ? Math.floor(keep * 0.8) : keep - 10;
			if (keep <= 0) break;
		}
	}

	if (!fits(payload)) {
		// Ha még mindig nagy, a failed listát is vágjuk
		let keep = Math.min(failedAll.length, 500);
		while (keep >= 0) {
			payload.failed = failedAll.slice(0, keep);
			payload.meta.failedStored = payload.failed.length;
			payload.meta.truncated = true;
			if (fits(payload)) break;
			keep = keep > 50 ? Math.floor(keep * 0.8) : keep - 10;
			if (keep <= 0) break;
		}
	}

	// Végezetül NE tároljuk az eredeti run.items tömböt a dokumentumban
	delete payload.items;
	return payload;
}

/**  **/

/** Egy folyamat futtatása és logolása */
async function runProcessById(processId) {
	try {
		await updateRates(false);
	} catch (e) {
		console.warn('[RUNNER] Árfolyam frissítés kihagyva:', e?.message || e);
	}
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
			failed: 0,
			skippedNoChange: 0,
			skippedNoKey: 0,
			skippedNotFound: 0, // összesítő (a *_Count-ra fogjuk állítani)
			skippedNotFoundCount: 0, // nyers számláló (opcionális, de hagyjuk meg)
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
		// console.log('[RUNNER][DEBUG]', {
		// 	processId,
		// 	shopId: proc.shopId,
		// 	shopDoc: {
		// 		...shop,
		// 		apiKey: resolvedApiKey ? '[RESOLVED]' : '[NOT RESOLVED]',
		// 	},
		// });

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
		let trans = await transformData(recs, proc);
		const t4 = Date.now();

		run.counts.input = Array.isArray(recs) ? recs.length : 0;
		run.counts.output = Array.isArray(trans) ? trans.length : 0;
		run.counts.total = run.counts.input;

		// <<< FEED KULCS visszaemelése a transzformált sorokba (mint az index.js-ben)
		if (proc?.keyFields?.feed) {
			const feedKey = String(proc.keyFields.feed);
			trans = trans.map((row, i) => {
				const src = recs[i] || {};
				return src[feedKey] === undefined
					? row
					: { ...row, [feedKey]: src[feedKey] };
			});
		}

		// 4) Upload
		let stats = {
			modified: [],
			failed: [],
			skippedNoKeyCount: 0,
			skippedNoChangeCount: 0,
			skippedNotFoundCount: 0,
			dryRun: true,
		};

		const t5 = Date.now();

		stats = await uploadToUnas(trans, proc, shop);

		const t6 = Date.now();

	run.counts.modified = Array.isArray(stats?.modified)
		? stats.modified.length
		: 0;
	run.counts.failed = Array.isArray(stats?.failed) ? stats.failed.length : 0;
	run.counts.skippedNoChange = stats?.skippedNoChangeCount || 0;
	run.counts.skippedNoKey = stats?.skippedNoKeyCount || 0;
	run.counts.skippedNotFound = stats?.skippedNotFoundCount || 0;
	run.counts.feedSupplier = stats?.feedSupplierCount ?? run.counts.total ?? 0;
	run.counts.unasSupplier = stats?.unasSupplierCount ?? 0;

		run.items = [];

		for (const m of stats.modified || []) {
			const hasChange = m.changes && Object.keys(m.changes).length > 0;
			run.items.push({
				sku: m.sku ?? null,
				action: hasChange ? 'modify' : 'skip',
				changes: m.changes || {},
				before: m.before ?? null,
				after: m.after ?? null,
			});
		}
		// for (const s of stats.skippedNoKey || []) {
		// 	run.items.push({
		// 		sku: null,
		// 		action: 'skip',
		// 		error: 'No key',
		// 	});
		// }
		// for (const s of stats.skippedNotFound || []) {
		// 	run.items.push({
		// 		sku: null,
		// 		action: 'skip',
		// 		error: 'Not found',
		// 	});
		// }

		for (const f of stats.failed || []) {
			run.items.push({
				sku: f.sku ?? null,
				action: 'fail',
				error: f.error || f.message || f.reason || f.statusText || 'Failed',
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
				const failedPreview = (run.items || [])
					.filter((it) => it.action === 'fail')
					.slice(0, 5)
					.map(
						(it) =>
							`<li><code>${it.sku || '-'}</code> – ${String(
								it.error || ''
							).replace(/[<>]/g, '')}</li>`
					)
					.join('');

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
	${failedPreview ? `<h3>Példák:</h3><ul>${failedPreview}</ul>` : ''}
  <small style="color:#888;">Ez az email automatikusan generált értesítés.</small>
</div>
`;
				await sendNotification(subject, { html: body });
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
				await sendNotification(subject, { html: body });
			}
		} catch (e) {
			console.warn('[RUNNER] Email notification error:', e?.message || e);
		}
	} catch (err) {
		const msg = err?.message || String(err);
		run.error = `[runProcessById] ${msg}`;

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

			const subject = `❌ Folyamat futtatási hiba - ${procName}`;
			const body = `
<div style="font-family:Arial,sans-serif;">
  <h2 style="color:#c62828;">Hiba történt a szinkron futtatásakor</h2>
  <table style="border-collapse:collapse;">
    <tr><td><b>Shop:</b></td><td>${shopName}</td></tr>
    <tr><td><b>Folyamat:</b></td><td>${procName}</td></tr>
    <tr><td><b>Indult:</b></td><td>${started}</td></tr>
    <tr><td><b>Befejeződött:</b></td><td>${finished}</td></tr>
    <tr><td><b>Időtartam:</b></td><td>${duration}</td></tr>
    <tr><td><b>Hiba oka:</b></td><td style="color:#c62828;">${msg}</td></tr>
  </table>
  <br>
  <small style="color:#888;">Ez az email automatikusan generált értesítés.</small>
</div>
`;

			await sendNotification(subject, { html: body });
		} catch (mailErr) {
			console.warn(
				'[RUNNER] Email küldés HIBA (runProcessById error ág):',
				mailErr?.message || mailErr
			);
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
