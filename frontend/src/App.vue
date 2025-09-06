<template>
	<el-container>
		<el-header>
			<div
				style="
					display: flex;
					align-items: center;
					justify-content: space-between;
					height: 100%;
				"
			>
				<h1 style="margin: 0 auto">
					<el-icon style="vertical-align: middle; margin-right: 8px"
						><Sunny
					/></el-icon>
					Unas szinkron
					<span v-if="selectedShop">
						- {{ shops.find((s) => s.shopId === selectedShop)?.name || '' }}
					</span>
					<el-icon style="vertical-align: middle; margin-left: 8px"
						><Sunny
					/></el-icon>
				</h1>
			</div>
		</el-header>
		<template v-if="ready && user">
			<!-- <router-view /> -->
				<el-main>
				<ExchangeRates />
				<div class="webshop-switcher-line">
					<template v-if="user">
						<el-button size="small" @click="logout">Kijelentkezés</el-button>
					</template>
					<ShopSelector v-model:shopId="selectedShop" :shops="shops" />
				</div>
				<ProcessTable
					:processes="filteredProcesses"
					:shops="shops"
					@edit="openForm"
					@delete="handleDelete"
					@run-complete="loadLogs"
				/>
				<el-button type="primary" class="new-process-btn" @click="openForm()"
					><el-icon style="vertical-align: middle; margin-right: 4px"
						><Plus /></el-icon
					>Új szinkron létrehozása</el-button
				>

				<LogsViewer />

				<!-- Modal a ProcessForm számára -->
				<el-dialog
					v-model="showForm"
					width="800px"
					class="process-modal"
					fullscreen
				>
					<template #header="{ titleId, titleClass }">
						<div class="my-header">
							<h1 :id="titleId" :class="titleClass">
								Szinkron folyamat
								{{
									selectedShop
										? ' - ' +
										(shops.find((s) => s.shopId === selectedShop)?.name || '')
										: ''
								}}
							</h1>
						</div>
					</template>
					<ProcessForm
						:key="editedProcess.processId || 'new'"
						:shops="shops"
						:initial="editedProcess"
						:activeShopId="selectedShop || ''"
						@save="saveProcess"
					/>
				</el-dialog>
			</el-main>
		</template>

		<!-- Kijelentkezve -->
		<template v-else-if="ready && !user">
			<el-main style="text-align: center; padding-top: 5rem">
				<h2>Nem vagy bejelentkezve</h2>
			<p>Kérlek jelentkezz be az admin felülethez.</p>
				<el-button size="small" type="primary" @click="login"
					>Bejelentkezés</el-button
				>
			</el-main>
		</template>

  <!-- Auth állapot még nem ismert -->
  <template v-else >Betöltés…</template>
	</el-container>
</template>

<script>
	import { ref, computed, onMounted } from 'vue';
	import ShopSelector from './components/ShopSelector.vue';
	import ProcessTable from './components/ProcessTable.vue';
	import ProcessForm from './components/ProcessForm.vue';
	import ExchangeRates from './components/ExchangeRates.vue';
	import LogsViewer from './components/LogsViewer.vue';
	import api from './services/api';
	import { auth, db } from './firestore';
	import {
		GoogleAuthProvider,
		signInWithPopup,
		onAuthStateChanged,
		signOut,
	} from 'firebase/auth';
	import {
		collection,
		onSnapshot,
		query,
		orderBy,
		limit,
	} from 'firebase/firestore';
	import { ElMessage } from 'element-plus';

	export default {
		watch: {},
		data() {
			return {};
		},
		components: {
			ShopSelector,
			ProcessTable,
			LogsViewer,
			ProcessForm,
			ExchangeRates,
		},
		setup() {
			const shops = ref([]);
			const selectedShop = ref(null);
			const processes = ref([]);
			const logs = ref([]);
			const showForm = ref(false);
			const editedProcess = ref({});

			const loadConfig = async () => {
				if (!user.value) return;
				const res = await api.getConfig();
				shops.value = res.data.shops;
				processes.value = res.data.processes;
				if (!selectedShop.value && shops.value.length) {
					selectedShop.value = shops.value[0].shopId;
				}
			};

			const loadLogs = async () => {
				if (!user.value) return;
				const res = await api.getLogs();
				logs.value = res.data;
			};

			const filteredProcesses = computed(() =>
				processes.value.filter((p) => p.shopId === selectedShop.value)
			);

			const openForm = (processId = null) => {
				if (processId) {
					const found = Array.isArray(processes.value)
						? processes.value.find((p) => p.processId === processId)
						: null;
					editedProcess.value = found ? { ...found } : {};
				} else {
					editedProcess.value = {
						processId: '',
						shopId: selectedShop.value || '',
						displayName: '',
						feedUrl: '',
						frequency: '24h',
						currency: 'EUR',
						targetCurrency: 'HUF',
						pricingFormula: '',
						vat: 27,
						priceMargin: 0,
						discount: 0,
						rounding: 100,
						fieldMapping: {},
					};
				}
				showForm.value = true;
			};

			const saveProcess = async (proc) => {
				// lokális lista frissítése
				const idx = processes.value.findIndex(
					(p) => p.processId === proc.processId
				);
				if (idx > -1) {
					processes.value.splice(idx, 1, proc);
				} else {
					processes.value.push(proc);
				}

				await api.saveConfig({ processes: processes.value });

				showForm.value = false;
				loadConfig();
			};

			async function handleDelete(processId) {
				try {
					await api.deleteConfig(processId);
					await loadConfig();
					ElMessage.success('Folyamat törölve.');
				} catch (err) {
					ElMessage.error('A folyamat törlése sikertelen.');
					console.error(err);
				} finally {
					loadLogs();
				}
			}

			// Állapotok, ha még nincsenek:
			const user = ref(null);
			const ready = ref(false);
			const fsUnsubs = []; // leiratkozások gyűjtése Firestore streamről

			function stopFs() {
				while (fsUnsubs.length) {
					const u = fsUnsubs.pop();
					try {
						typeof u === 'function' && u();
					} catch {}
				}
			}

			// Firestore read-only stream indítása
			function startFs() {
				stopFs();

				// shops – név szerint rendezve
				const unsubShops = onSnapshot(
					query(collection(db, 'shops'), orderBy('name', 'asc'), limit(500)),
					(snap) => {
						shops.value = snap.docs.map((d) => {
							const data = d.data(); // NINCS értékátalakítás
							// biztosítjuk, hogy legyen shopId mező (ha nincs a doksiban)
							return { shopId: data.shopId ?? d.id, ...data };
						});
						// Ha nincs kiválasztott shop, próbáljuk az elsőt
						if (!selectedShop.value && shops.value.length) {
							selectedShop.value = shops.value[0].shopId;
						}
					}
				);
				fsUnsubs.push(unsubShops);

				// processes – megjelenítéshez elég, ha az összeset streameljük (szűrés marad a computed-ben)
				const unsubProc = onSnapshot(
					query(
						collection(db, 'processes'),
						orderBy('displayName', 'asc'),
						limit(1000)
					),
					(snap) => {
						processes.value = snap.docs.map((d) => {
							const data = d.data(); // NINCS értékátalakítás
							return { processId: data.processId ?? d.id, ...data };
						});
					}
				);
				fsUnsubs.push(unsubProc);
			}

			// Auth állapot figyelése: ha be van jelentkezve, indul a Firestore stream; különben API fallback
			onAuthStateChanged(auth, (u) => {
				user.value = u;
				stopFs();
				if (u) {
					startFs();
				} else {
					// Fallback: marad az eddigi API olvasás
					loadConfig();
				}
			});

			// Opcionális gyors login gombhoz ezek a metódusok rendelkezésre állnak:
			async function login() {
				await signInWithPopup(auth, new GoogleAuthProvider());
			}
			async function logout() {
				await signOut(auth);
			}


			onMounted(() => {
				if (user.value) {
					loadConfig();
					loadLogs();
				}
				setInterval(() => {
					if (user.value) loadLogs();
				}, 100000);
				const un = onAuthStateChanged(auth, (u) => {
					user.value = u;
					ready.value = true;   // <-- csak ekkor engedjük a UI-t dönteni
					if (u) {
						loadConfig();
						loadLogs();
					}
				});
			});

			async function login() { await signInWithPopup(auth, new GoogleAuthProvider()); }
			async function logout() { await signOut(auth); }

			return {
				shops,
				selectedShop,
				processes,
				logs,
				filteredProcesses,
				showForm,
				editedProcess,
				openForm,
				saveProcess,
				handleDelete,
				loadLogs,
				user,
				login,
				logout,
				ready,
			};
		},
	};
</script>

<style>
	body {
		font-family: 'Inter', sans-serif;
		margin: 0;
		padding: 0;
		background-color: #f5f5f5;
		padding-bottom: 4rem;
	}

	.new-process-btn {
		position: fixed;
		bottom: 1rem;
		right: 1rem;
		z-index: 1000;
	}

	.process-modal .el-dialog__header {
		padding-right: 0 !important;
	}
	.process-modal .my-header {
		display: flex;
		align-items: center;
		justify-content: center;
		border-bottom: 1px solid #ddd;
		margin-bottom: 1rem;
	}
	.process-modal .my-header .el-dialog__title {
		font-size: 1.3125rem;
	}
	.process-modal .el-dialog__headerbtn {
		background-color: #e5e5e5;
		color: black;
	}
	.process-modal .el-dialog__headerbtn .el-icon {
		color: black;
	}
	.webshop-switcher-line {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1rem;
		background-color: var(--el-color-info-light-5);
		padding: 0.5rem 1rem;
		margin: 0;
	}
	.process-modal {
		max-width: 1000px;
	}
</style>
