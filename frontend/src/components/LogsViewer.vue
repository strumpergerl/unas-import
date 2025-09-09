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

	const rows = ref([]);
	const loading = ref(false);
	const VITE_USE_FS_CLIENT_READ = import.meta.env.VITE_USE_FS_CLIENT_READ;
	const pageSize = ref(10);
	const currentPage = ref(1);

	const pagedRows = computed(() => {
		const start = (currentPage.value - 1) * pageSize.value;
		return rows.value.slice(start, start + pageSize.value);
	});

	function handlePageChange(page) {
		currentPage.value = page;
	}

	function hasChanges(it) {
		if (!it || !it.changes) return false;
		// Legalább egy olyan változás kell, ahol az új érték nem undefined/null
		return Object.values(it.changes).some(chg => chg && chg.to !== undefined && chg.to !== null);
	}

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
			query(collection(db, 'runs'), orderBy('startedAt', 'desc'), limit(100)),
			(snap) => {
				rows.value = snap.docs.map((d) => ({ id: d.id, ...d.data() })); // NINCS értékátalakítás
			}
		);
	}

	function rowStatus(it) {
		if (it.error) return { label: 'Fail', type: 'danger' };
		if (hasChanges(it)) return { label: 'Modify', type: 'success' };
		return { label: 'Skip', type: 'warning' };
	}

	onAuthStateChanged(auth, (u) => {
		// Ha engedélyezett a Firestore read és be van jelentkezve a user, használjuk a streamet,
		// különben marad az API.
		stopFs();
		if (VITE_USE_FS_CLIENT_READ && u) {
			startFs();
		} else {
			load(); // API fallback
		}
	});

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

	async function load() {
		loading.value = true;
		try {
			const { data } = await api.getLogs(); // GET /api/logs
			rows.value = Array.isArray(data) ? data : [];
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
</script>

<template>
	<div class="p-4" style="margin-top: 5rem">
		<el-divider content-position="center">Folyamat logok</el-divider>

		<el-table
			:data="pagedRows"
			v-loading="loading"
			border
			stripe
			size="small"
			:default-sort="{ prop: 'startedAt', order: 'descending' }"
			row-key="id"
		>
			<el-table-column type="expand" width="40">
				<template #default="{ row }">
					<div class="p-2">
						<div class="mb-2 text-sm text-gray-600">
							<span class="mr-3"
								>Run ID: <code>{{ row.id }}</code></span
							>
							<span v-if="row.error" class="text-red-600 font-medium"
								>Hiba: {{ row.error }}</span
							>
						</div>

						<el-table :data="row.items" border size="small" row-key="sku">
							<el-table-column label="#" type="index" width="50" />
							<el-table-column label="Státusz" width="90">
								<template #default="{ row: it }">
									<el-tag :type="rowStatus(it).type">{{
										rowStatus(it).label
									}}</el-tag>
								</template>
							</el-table-column>
							<el-table-column prop="sku" label="SKU" min-width="140" />
							<el-table-column prop="key" label="Feed kulcs" min-width="160" />
							<el-table-column
								prop="unasKey"
								label="Unas kulcs"
								min-width="140"
							/>
							<el-table-column label="Változások" min-width="380">
								<template #default="{ row: it }">
									<div
										v-if="rowStatus(it).label === 'Modify' && hasChanges(it)"
										class="space-y-1"
									>
										<div
											v-for="(chg, name) in it.changes"
											:key="name"
											class="text-xs"
										>
											<strong>{{ name }}:</strong>
											<span
												style="text-decoration: line-through; margin-left: 4px"
											>
												<span>
													<span
														v-if="chg.from !== null && chg.from !== undefined"
														>{{ chg.from }}</span
													>
													<span v-else style="color: #aaa">–</span>
													<span style="margin: 0 2px">→</span>
												</span>
												<span style="color: #222; font-weight: bold">{{
													chg.to
												}}</span>
											</span>
										</div>
									</div>
									<div v-else class="text-xs text-gray-500 italic">
										Nincs változás (érték azonos maradt).
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
				<template #default="{ row }">{{
					row.counts?.output ?? row.counts?.input ?? 0
				}}</template>
			</el-table-column>
			<el-table-column label="Modify" width="90" align="center">
				<template #default="{ row }">
					<el-tag type="success">{{
						row.items?.filter((it) => !it.error && hasChanges(it)).length || 0
					}}</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="Skip" width="90" align="center">
				<template #default="{ row }">
					<el-tag type="warning">{{
						row.items?.filter((it) => !it.error && !hasChanges(it)).length || 0
					}}</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="Fail" width="90" align="center">
				<template #default="{ row }">
					<el-tag type="danger">{{
						row.items?.filter((it) => it.error).length || 0
					}}</el-tag>
				</template>
			</el-table-column>
		</el-table>
		<el-pagination
			v-model:current-page="currentPage"
			:page-size="pageSize"
			:total="rows.length"
			layout="prev, pager, next"
			@current-change="handlePageChange"
			class="mt-4"
		/>
	</div>
</template>
