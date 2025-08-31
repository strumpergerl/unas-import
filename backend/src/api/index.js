// backend/src/api/index.js
require('../bootstrapEnv');
const express = require('express');
const downloadFile = require('../core/downloadFile');
const parseData = require('../core/parseData');
const transformData = require('../core/transformData');
const uploadToUnas = require('../core/uploadToUnas');
const shops = require('../config/shops.json');
const processes = require('../config/processes.json');
const rateUpdater = require('../utils/rateUpdater');
const { scheduleProcesses } = require('../scheduler');
const { getLogs } = require('../runner');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { db } = require('../db/firestore');

const fsSync = require('fs');
const pathMod = require('path');
const PROCESSES_FILE = pathMod.resolve(__dirname, '../config/processes.json');

const candidates = [
	path.resolve(__dirname, '../../.env'), // monorepo gyökér
	path.resolve(__dirname, '../.env'), // backend/.env
	path.resolve(process.cwd(), '.env'), // futtatási CWD
];

for (const p of candidates) {
	if (fs.existsSync(p)) {
		dotenv.config({ path: p });
		console.log(`[ENV] Loaded: ${p}`); // NEM logol kulcsokat!
		break;
	}
}

/** Visszaadja a process configot azonosító alapján. */
async function getProcessConfigById(processId) {
	const snap = await db.collection('processes').doc(String(processId)).get();
	if (!snap.exists) return null;
	return { processId: snap.id, ...snap.data() };
}

const router = express.Router();
const logs = [];

// JSON body parsing
router.use(express.json());

// Config beolvasása
router.get('/config', async (req, res) => {
	try {
		const shopsSnap = await db.collection('shops').get();
		const shops = shopsSnap.docs.map((d) => ({ shopId: d.id, ...d.data() }));

		const procsSnap = await db.collection('processes').get();
		const processes = procsSnap.docs.map((d) => ({
			processId: d.id,
			...d.data(),
		}));

		res.json({ shops, processes }); // <-- fontos: mindig legyen tömb
	} catch (e) {
		res.status(500).json({ error: e.message, shops: [], processes: [] });
	}
});

// Config mentése (POST)
router.post('/config', async (req, res) => {
	try {
		const { processes: newProcesses } = req.body || {};
		if (!Array.isArray(newProcesses)) {
			return res.status(400).json({ error: 'processes tömb szükséges' });
		}

		const batch = db.batch();
		const seen = new Set();

		newProcesses.forEach((p) => {
			const id = String(p.processId || '');
			if (!id) return;
			seen.add(id);
			const ref = db.collection('processes').doc(id);
			// ne duplikáld a kulcsot a docban:
			const { processId, ...data } = p;
			batch.set(ref, data, { merge: true });
		});

		// (opcionális) törlés: minden olyan process, ami nincs `seen`-ben
		const existing = await db.collection('processes').get();
		existing.forEach((doc) => {
			if (!seen.has(doc.id)) {
				batch.delete(db.collection('processes').doc(doc.id));
			}
		});

		await batch.commit();

		// Itt már nem kell schedule újraindítás fájlból; ha van ütemeződ,
		// olvasson Firestore snapshotból vagy indíts újra saját logikád szerint.
		res.json({ success: true });
	} catch (err) {
		console.error('/config POST error:', err);
		res.status(500).json({ error: err.message });
	}
});

// Folyamat futtatása
router.post('/run', async (req, res) => {
	try {
		const { processId } = req.body || {};
		if (!processId)
			return res
				.status(400)
				.json({ success: false, error: 'processId required' });

		const processConfig = await getProcessConfigById(processId);
		if (!processConfig)
			return res
				.status(404)
				.json({ success: false, error: `Process not found: ${processId}` });

		const t0 = Date.now();
		const dl = await downloadFile(processConfig.feedUrl);
		const rawSize = dl?.length || 0;

		const parsed = await parseData(dl, processConfig); // Array
		const parsedCount = Array.isArray(parsed) ? parsed.length : 0;
		console.log('[DEBUG] parsed sample:', parsed?.[0], 'count=', parsedCount);

		const transformed = await transformData(parsed, processConfig); // Array
		const transformedCount = Array.isArray(transformed)
			? transformed.length
			: 0;
		console.log(
			'[DEBUG] transformed sample:',
			transformed?.[0],
			'count=',
			transformedCount
		);

		// Opcionális „feltöltésre alkalmas” szűrő: csak ahol van SKU
		const withSku = (transformed || []).filter(
			(x) => x?.sku || x?.Sku || x?.SKU
		);
		const uploadCandidates = withSku.length;

		let uploadStats = null;

		// DRY-run esetén ne töltsünk
		if (!processConfig.dryRun) {
			await uploadToUnas(withSku, processConfig);
		}

		const dt = Date.now() - t0;
		return res.json({
			success: true,
			stats: {
				rawSize,
				parsedCount,
				transformedCount,
				uploadCandidates,
				durationMs: dt,
				upload: uploadStats,
			},
			sample: {
				parsed: parsed?.[0] || null,
				transformed: transformed?.[0] || null,
			},
		});
	} catch (e) {
		console.error('❌ /run hiba:', e);
		res.status(500).json({ success: false, error: String(e.message || e) });
	}
});

// Folyamat törlése
router.delete('/config/:processId', async (req, res) => {
	try {
		const { processId } = req.params;
		if (!processId)
			return res.status(400).json({ ok: false, error: 'processId required' });

		const ref = db.collection('processes').doc(String(processId));
		const snap = await ref.get();
		if (!snap.exists)
			return res
				.status(404)
				.json({ ok: false, error: 'Process not found', processId });

		const removed = { processId: snap.id, ...snap.data() };
		await ref.delete();

		return res.json({ ok: true, removed });
	} catch (e) {
		console.error('[DELETE /api/config/:processId] error:', e);
		return res.status(500).json({ ok: false, error: 'Internal error' });
	}
});

// Logok lekérdezése
router.get('/logs', (req, res) => {
	res.json(getLogs());
});

// Árfolyamok lekérése
router.get('/rates', (req, res) => {
	const { rates, lastUpdated } = rateUpdater.getRates();
	res.json({ rates, lastUpdated });
});

// Ütemezés indítása
scheduleProcesses(processes);

// Fejlesztői végpontok
const testUnas = require('./testUnas');
router.use('/test/unas', testUnas);

module.exports = router;
