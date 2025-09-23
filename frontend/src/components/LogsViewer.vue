<!-- frontend/src/components/LogsViewer.vue -->
<script setup>
	import { onMounted, ref, onBeforeUnmount, computed } from 'vue';
	import api from '../services/api';
	import { auth, db } from '../firestore';
	import { onAuthStateChanged } from 'firebase/auth';
	import {
		collection,
		onSnapshot,
		query,
		orderBy,
		limit,
	} from 'firebase/firestore';

	// ====== BELSŐ ÁLLAPOT (nincsenek props) ======
	const runs = ref([]); // a fő lista (FS-ből vagy API-ból töltjük)
	const loading = ref(false);
	const VITE_USE_FS_CLIENT_READ = import.meta.env.VITE_USE_FS_CLIENT_READ;

	// ====== PAGINÁCIÓ A FŐ LISTÁRA ======
	const pageSize = ref(10);
	const currentPage = ref(1);
	const pagedRuns = computed(() => {
		const start = (currentPage.value - 1) * pageSize.value;
		return runs.value.slice(start, start + pageSize.value);
	});
	function handlePageChange(page) {
		currentPage.value = page;
	}

	// ====== FIRESTORE STREAM ======
	let fsUnsub = null;
	function stopFs() {
		if (typeof fsUnsub === 'function') {
			try {
				fsUnsub();
			} catch {}
		}
		fsUnsub = null;
	}
	function startFs() {
		stopFs();
		fsUnsub = onSnapshot(
			query(collection(db, 'runs'), orderBy('startedAtTs', 'desc'), limit(100)),
			(snap) => {
				runs.value = snap.docs.map((d) => ({ id: d.id, ...d.data() })); // mezők értékeit nem alakítjuk át
			}
		);
	}

	// ====== AUTH + ADATFORRÁS VÁLASZTÁS ======
	onAuthStateChanged(auth, (u) => {
		stopFs();
		if (VITE_USE_FS_CLIENT_READ && u) {
			startFs();
		} else {
			load(); // API fallback
		}
	});

	async function load() {
		loading.value = true;
		try {
			const { data } = await api.getLogs(); // GET /api/logs
			runs.value = Array.isArray(data) ? data : [];
		} catch (e) {
			console.error('Log betöltési hiba:', e);
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		if (!VITE_USE_FS_CLIENT_READ) load();
	});
	onBeforeUnmount(stopFs);

	// ====== DÁTUM/IDŐ SEGÉDEK ======
	function toDateAny(v) {
		if (!v) return null;
		if (typeof v === 'string' || typeof v === 'number') return new Date(v);
		if (typeof v?.toDate === 'function') return v.toDate(); // Firestore Timestamp
		return null;
	}
	function fmt(v) {
		const d = toDateAny(v);
		return d ? d.toLocaleString() : '—';
	}
	function prettyMs(ms) {
		if (!ms && ms !== 0) return '—';
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	// ====== RÉSZLETEZŐ SOROK (modified + failed), régi forma fallback ======
	function detailRows(run) {
		const out = [];
		(run?.modified || []).forEach((m) => {
			out.push({
				status: 'modify',
				sku: m.sku ?? '',
				changes: m.changes || null,
				error: null,
			});
		});
		(run?.failed || []).forEach((f) => {
			out.push({
				status: 'fail',
				sku: f.sku ?? '',
				changes: null,
				error: f.error || 'Ismeretlen hiba',
			});
		});
		// Régi futások támogatása:
		if (!out.length && Array.isArray(run?.items)) {
			run.items.forEach((it) => out.push(it));
		}
		return out;
	}

	// ====== UI SEGÉDEK ======
	function rowStatus(it) {
		if (it.status === 'fail' || it.error)
			return { type: 'danger', label: 'Hibás' };
		if (it.status === 'modify') return { type: 'success', label: 'Változott' };
		return { type: 'info', label: 'Info' };
	}
	function hasChanges(it) {
		const ch = it?.changes;
		if (!ch || typeof ch !== 'object') return false;
		// van-e bármely mezőnél különbség (from != to)
		return Object.values(ch).some((v) => {
			if (v && typeof v === 'object' && ('from' in v || 'to' in v)) {
				const a = v?.from ?? '';
				const b = v?.to ?? '';
				return String(a) !== String(b);
			}
			return true; // primitív változás
		});
	}

	// Értékek barátságos formázása a kijelzéshez
	function formatChangeValue(name, v) {
		if (v === undefined || v === null || v === '') return '—';
		// rendelhetőség (1/0, true/false) → magyar címke
		if (name === 'orderable') {
			return v === 1 || v === '1' || v === true
				? 'Rendelhető'
				: 'Nem rendelhető';
		}
		// árak: egyszerű ezres tagolás (ha szám)
		if (name === 'price_net' || name === 'price_gross') {
			const n = Number(v);
			return Number.isFinite(n)
				? new Intl.NumberFormat('hu-HU').format(n)
				: String(v);
		}
		return String(v);
	}

	// A változás-objektumot (pl. { orderable:{from,to}, price_gross:{from,to} })
	// egységes listává lapítjuk, "korábbi → új" formában
	function filteredChanges(ch) {
		if (!ch || typeof ch !== 'object') return [];
		const out = [];
		for (const [name, val] of Object.entries(ch)) {
			if (val && typeof val === 'object' && ('from' in val || 'to' in val)) {
				out.push({
					name,
					from: formatChangeValue(name, val.from),
					to: formatChangeValue(name, val.to),
				});
			} else {
				// ritka: csak új érték ismert
				out.push({
					name,
					from: '—',
					to: formatChangeValue(name, val),
				});
			}
		}
		return out;
	}

	// ====== FEJLÉC SZÁMLÁLÓK (új séma) ======
	function modifiedCount(run) {
		return run?.counts?.modified ?? run?.meta?.modifiedTotal ?? 0;
	}
	function failedCount(run) {
		return run?.counts?.failed ?? run?.meta?.failedTotal ?? 0;
	}
	function skippedTotal(run) {
		const c = run?.counts || {};
		return (
			run?.skipped?.total ?? (c.skippedNoKey || 0) + (c.skippedNotFound || 0)
		);
	}
	function unchangedCount(run) {
		return (
			run?.counts?.skippedNoChange ?? run?.counts?.skippedNoChangeCount ?? 0
		);
	}
	function totalFor(run) {
		const c = run?.counts || {};
		const meta = run?.meta || {};
		const skipped = skippedTotal(run);
		if (Number.isFinite(c.total)) return c.total;
		return (
			(meta.modifiedTotal ?? c.modified ?? 0) +
			(meta.failedTotal ?? c.failed ?? 0) +
			skipped +
			(c.unchanged || 0)
		);
	}
</script>

<template>
	<div class="p-4" style="margin-top: 5rem">
		<el-divider content-position="center">Folyamat logok</el-divider>

		<!-- FŐ TÁBLA -->
		<el-table
			:data="pagedRuns"
			v-loading="loading"
			border
			stripe
			size="small"
			:default-sort="{ prop: 'startedAt', order: 'descending' }"
			row-key="id"
		>
			<el-table-column type="expand" width="40">
				<template #default="{ row }">
					<div class="p-2 space-y-2">
						<div
							class="mb-2 text-sm text-gray-600"
							style="padding: 1rem 1rem; background: #eee; font-weight: bold"
						>
							<span class="mr-3"
								>Run ID: <code>{{ row.id }}</code></span
							>
							<span v-if="row.error" class="text-red-600 font-medium"
								>Hiba: {{ row.error }}</span
							>
							<span
								v-if="row?.meta?.truncated"
								class="text-xs text-gray-500"
								style="display: block; margin-top: 0.5rem"
							>
								Megjelenítve: <br />
								összesen {{ totalFor(row) }} termék,<br />
								módosított {{ row.meta.modifiedStored }}/{{
									row.meta.modifiedTotal
								}},<br />
								hibás {{ row.meta.failedStored }}/{{ row.meta.failedTotal }}.
							</span>
						</div>

						<!-- RÉSZLETEZŐ TÁBLA -->
						<el-table :data="detailRows(row)" border size="small" row-key="sku">
							<el-table-column label="#" type="index" width="50" />
							<el-table-column label="Státusz" width="150">
								<template #default="{ row: it }">
									<el-tag :type="rowStatus(it).type">{{
										rowStatus(it).label
									}}</el-tag>
								</template>
							</el-table-column>
							<el-table-column prop="sku" label="SKU" min-width="200" />

							<el-table-column label="Változások" min-width="320">
								<template #default="{ row: it }">
									<div
										v-if="rowStatus(it).label === 'Változott' && hasChanges(it)"
										class="space-y-1"
									>
										<div
											v-for="chg in filteredChanges(it.changes)"
											:key="chg.name"
											class="text-xs"
										>
											<strong>{{ chg.name }}:</strong>
											<span style="margin-left: 4px">
												<!-- Mindig a korábbi legyen elöl -->
												<span
													v-if="chg.from !== undefined"
													style="text-decoration: line-through; color: #888"
												>
													{{ chg.from }}
												</span>
												<span style="margin: 0 2px">→</span>
												<span style="color: #222; font-weight: bold">{{
													chg.to
												}}</span>
											</span>
										</div>
									</div>
									<div v-else class="text-xs text-gray-500 italic">
										Nincs változás
									</div>
								</template>
							</el-table-column>

							<el-table-column
								prop="error"
								label="Megjegyzés / Hiba"
								min-width="220"
							>
								<template #default="{ row: it }">
									<span v-if="it.error" class="text-red-600">{{
										it.error
									}}</span>
									<span v-else class="text-gray-500">—</span>
								</template>
							</el-table-column>
						</el-table>
					</div>
				</template>
			</el-table-column>

			<el-table-column prop="processName" label="Process" min-width="180" />
			<el-table-column prop="shopName" label="Shop" min-width="140" />
			<el-table-column prop="startedAt" label="Indult" min-width="170">
				<template #default="{ row }">{{ fmt(row.startedAt) }}</template>
			</el-table-column>
			<el-table-column prop="finishedAt" label="Befejeződött" min-width="170">
				<template #default="{ row }">{{ fmt(row.finishedAt) }}</template>
			</el-table-column>
			<el-table-column prop="durationMs" label="Időtartam" width="110">
				<template #default="{ row }">{{ prettyMs(row.durationMs) }}</template>
			</el-table-column>

			<el-table-column label="Összesen" width="100" align="center">
				<template #default="{ row }">{{ totalFor(row) }}</template>
			</el-table-column>
			<el-table-column label="Változott" width="90" align="center">
				<template #default="{ row }"
					><el-tag type="success">{{ modifiedCount(row) }}</el-tag></template
				>
			</el-table-column>
			<el-table-column label="Nem változott" width="100" align="center">
				<template #default="{ row }"
					><el-tag type="warning">{{ unchangedCount(row) }}</el-tag></template
				>
			</el-table-column>
			<el-table-column label="Hibás" width="90" align="center">
				<template #default="{ row }"
					><el-tag type="danger">{{ failedCount(row) }}</el-tag></template
				>
			</el-table-column>
		</el-table>

		<el-pagination
			v-model:current-page="currentPage"
			:page-size="pageSize"
			:total="runs.length"
			layout="prev, pager, next"
			@current-change="handlePageChange"
			class="mt-4"
		/>
	</div>
</template>
