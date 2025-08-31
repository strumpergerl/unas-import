<template>
	<el-container>
		<el-header>
			<div
				style="
					display: flex;
					align-items: center;
					justify-content: space-between;
				"
			>
				<h1 style="margin: 0 auto">Unas Importer Dashboard</h1>
				<ShopSelector v-model:shopId="selectedShop" :shops="shops" />
			</div>
		</el-header>
		<el-main>
			<ExchangeRates />
			<el-button type="primary" class="new-process-btn" @click="openForm()"
				>Új szinkron létrehozása</el-button
			>
			<ProcessTable
				:processes="filteredProcesses"
				:shops="shops"
				@edit="openForm"
				@delete="handleDelete"
				@run-complete="loadLogs"
			/>
			
			<LogsViewer :logs="logs" />
			
			<!-- Modal a ProcessForm számára -->
			<el-dialog
				title="Szinkron folyamat szerkesztése"
				v-model="showForm"
				width="800px"
				@close="showForm = false"
			>
				<ProcessForm
					:key="editedProcess.processId || 'new'"
					:shops="shops"
					:initial="editedProcess"
					@save="saveProcess"
					@cancel="showForm = false"
				/>
			</el-dialog>
		</el-main>
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
	import axios from 'axios';
	import { ElMessage } from 'element-plus';

	export default {
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
				const res = await api.getConfig();
				shops.value = res.data.shops;
				processes.value = res.data.processes;
				if (!selectedShop.value && shops.value.length) {
					selectedShop.value = shops.value[0].shopId;
				}
			};

			const loadLogs = async () => {
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
						shopId: '',
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

			onMounted(() => {
				loadConfig();
				loadLogs();
				setInterval(loadLogs, 100000);
			});

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
</style>
