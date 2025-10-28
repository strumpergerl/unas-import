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
						-
						{{
							(shops || []).find((s) => s.shopId === selectedShop)?.name || ''
						}}
					</span>
					<el-icon style="vertical-align: middle; margin-left: 8px"
						><Sunny
					/></el-icon>
				</h1>
				<template v-if="user">
					<el-button @click="logout" circle type="danger">
						<el-icon><SwitchButton /></el-icon>
					</el-button>
				</template>
			</div>
		</el-header>
		<template v-if="ready && user">
			<!-- <router-view /> -->
			<el-main>
				<ExchangeRates :user="user" />
				<div class="webshop-switcher-line">
					<el-button type="success" class="new-process-btn" @click="openForm()"
						><el-icon style="vertical-align: middle; margin-right: 4px"
							><Plus /></el-icon
						>Új szinkron létrehozása</el-button
					>
					<ShopSelector v-model:shopId="selectedShop" :shops="shops" />
				</div>
				<ProcessTable
					:processes="filteredProcesses"
					:shops="shops"
					@edit="openForm"
					@delete="handleDelete"
					@run-complete="loadLogs"
				/>

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
										  ((shops || []).find((s) => s.shopId === selectedShop)
												?.name || '')
										: ''
								}}
							</h1>
						</div>
					</template>
					<ProcessForm
						:key="editedProcess.processId || 'new'"
						:shops="shops"
						:user="user"
						:initial="editedProcess"
						:activeShopId="selectedShop || ''"
						:show="showForm"
						@save="saveProcess"
						@cancel="showForm = false"
					/>
				</el-dialog>
			</el-main>
		</template>

		<!-- Kijelentkezve -->
		<template v-else-if="ready && !user">
			<el-main style="text-align: center; padding-top: 5rem">
				<h2>Nem vagy bejelentkezve</h2>
				<p>Kérlek jelentkezz be az admin felülethez.</p>

				<el-button @click="loginWithGoogle" class="mt-10">Belépés Google-lel</el-button>

				<!-- Ha NINCS bejelentkezve: e-mail/jelszó űrlap -->
				<el-card class=" max-w-md m-auto mt-10">
					<template #header>
						<div class="flex items-center justify-between">
							<span>{{
								mode === 'login' ? 'Bejelentkezés' : 'Regisztráció'
							}}</span>
							<el-button link @click="toggleMode">
								{{
									mode === 'login'
										? 'Nincs még fiókod? Regisztrálj'
										: 'Van fiókod? Jelentkezz be'
								}}
							</el-button>
						</div>
					</template>

					<el-form
						:model="form"
						:rules="rules"
						ref="formRef"
						label-width="120px"
						@submit.prevent
					>
						<el-form-item label="E-mail" prop="email">
							<el-input v-model="form.email" autocomplete="email" />
						</el-form-item>

						<el-form-item label="Jelszó" prop="password">
							<el-input
								v-model="form.password"
								type="password"
								autocomplete="current-password"
								show-password
							/>
						</el-form-item>

						<el-form-item style="margin-top: 2rem;">
							<el-button type="primary" :loading="loading" @click="submitEmail">
								{{ mode === 'login' ? 'Belépés' : 'Regisztráció' }}
							</el-button>
						</el-form-item>
					</el-form>
				</el-card>
			</el-main>
		</template>

		<!-- Auth állapot még nem ismert -->
		<template v-else>
			<el-main
				style="
					display: flex;
					align-items: center;
					justify-content: center;
					height: 60vh;
				"
			>
				<div style="text-align: center">
					<el-icon class="is-loading" style="font-size: 48px; color: #409eff">
						<Loading />
					</el-icon>
				</div>
			</el-main>
		</template>
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
		createUserWithEmailAndPassword,
		signInWithEmailAndPassword,
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

			let configCache = null;
			let configCacheTs = 0;
			let logsCache = null;
			let logsCacheTs = 0;
			const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 perc
			const LOGS_CACHE_TTL_MS = 30 * 1000; // log marad 30s

			const loadConfig = async (force = false) => {
				if (!user.value) return;
				const now = Date.now();
				if (
					!force &&
					configCache &&
					now - configCacheTs < CONFIG_CACHE_TTL_MS
				) {
					shops.value = configCache.shops;
					processes.value = configCache.processes;
					if (!selectedShop.value && shops.value.length) {
						selectedShop.value = shops.value[0].shopId;
					}
					return;
				}
				const res = await api.getConfig();
				shops.value = res.data.shops;
				processes.value = res.data.processes;
				configCache = { shops: res.data.shops, processes: res.data.processes };
				configCacheTs = now;
				if (!selectedShop.value && shops.value.length) {
					selectedShop.value = shops.value[0].shopId;
				}
			};

			const loadLogs = async (force = false) => {
				if (!user.value) return;
				const now = Date.now();
				if (!force && logsCache && now - logsCacheTs < LOGS_CACHE_TTL_MS) {
					logs.value = logsCache;
					return;
				}
				const res = await api.getLogs();
				logs.value = res.data;
				logsCache = res.data;
				logsCacheTs = now;
			};

			const filteredProcesses = computed(() =>
				(processes.value || []).filter((p) => p.shopId === selectedShop.value)
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

				await api.saveConfig(proc);

				configCache = null; // cache törlés
				configCacheTs = 0;
				showForm.value = false;
				loadConfig();
			};

			async function handleDelete(processId) {
				try {
					await api.deleteConfig(processId);
					configCache = null; // cache törlés
					configCacheTs = 0;
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

			onMounted(() => {
				const unAuth = onAuthStateChanged(auth, async (u) => {
					user.value = u;
					ready.value = true;

					stopFs(); // előző FS streamek leállítása
					if (u) {
						startFs(); // FS stream indítása csak belépve
						await loadConfig(true);
						await loadLogs(true);
					} else {
						await loadConfig(true); // kijelentkezve API fallback
					}
				});
				// (opcionálisan: onBeforeUnmount(() => unAuth && unAuth()))
			});

			// Google login
			const loginWithGoogle = async () => {
				try {
					const provider = new GoogleAuthProvider();
					await signInWithPopup(auth, provider);
					ElMessage.success('Sikeres bejelentkezés (Google)');
				} catch (e) {
					ElMessage.error(firebaseErr(e));
				}
			};

			// E-mail/jelszó login
			const mode = ref('login'); // 'login' | 'register'
			const loading = ref(false);
			const formRef = ref();
			const form = ref({ email: '', password: '' });

			const rules = {
				email: [
					{
						required: true,
						message: 'Add meg az e-mail címed',
						trigger: 'blur',
					},
				],
				password: [
					{ required: true, message: 'Add meg a jelszót', trigger: 'blur' },
				],
			};

			const toggleMode = () => {
				mode.value = mode.value === 'login' ? 'register' : 'login';
			};

			const submitEmail = async () => {
				try {
					await formRef.value?.validate();
					loading.value = true;
					if (mode.value === 'login') {
						await signInWithEmailAndPassword(
							auth,
							form.value.email,
							form.value.password
						);
						ElMessage.success('Sikeres bejelentkezés');
					} else {
						const cred = await createUserWithEmailAndPassword(
							auth,
							form.value.email,
							form.value.password
						);
						ElMessage.success('Sikeres regisztráció');
					}
				} catch (e) {
					ElMessage.error(firebaseErr(e));
				} finally {
					loading.value = false;
				}
			};

			const logout = async () => {
				try {
					await signOut(auth);
					ElMessage.success('Kijelentkezve');
				} catch (e) {
					ElMessage.error(firebaseErr(e));
				}
			};

			function firebaseErr(e) {
				const code = e?.code || '';
				const map = {
					'auth/email-already-in-use': 'Ezzel az e-mail címmel már van fiók.',
					'auth/invalid-email': 'Érvénytelen e-mail cím.',
					'auth/weak-password': 'A jelszó túl gyenge.',
					'auth/user-not-found': 'Nincs ilyen felhasználó.',
					'auth/wrong-password': 'Hibás jelszó.',
					'auth/popup-closed-by-user': 'A bejelentkezési ablak bezárult.',
				};
				return map[code] || e?.message || 'Ismeretlen hiba';
			}

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
				loginWithGoogle,
				logout,
				ready,
				mode,
				loading,
				formRef,
				form,
				rules,
				toggleMode,
				submitEmail,
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
		justify-content: space-between;
		margin-bottom: 1rem;
		background-color: var(--el-color-info-light-5);
		padding: 0.5rem 1rem;
		margin: 0;
	}
	.process-modal {
		max-width: 1000px;
	}
	.max-w-md {
		max-width: 520px;
	}
	.m-auto {
		margin-left: auto;
		margin-right: auto;
	}
	.mt-10 {
		margin-top: 2.5rem;
	}
	.flex {
		display: flex;
	}
	.items-center {
		align-items: center;
	}
	.justify-between {
		justify-content: space-between;
	}
	.gap-2 {
		gap: 0.5rem;
	}
	.font-semibold {
		font-weight: 600;
	}
	.text-lg {
		font-size: 1.125rem;
	}
</style>
