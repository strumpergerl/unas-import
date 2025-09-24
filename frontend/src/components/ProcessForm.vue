<!-- src/components/ProcessForm.vue -->
<template>
	<el-form :model="form" label-width="200px">
		<el-form-item label="Folyamat neve">
			<el-input
				v-model="form.displayName"
				placeholder="Hogy könnyebben tudd azonosítani"
			/>
		</el-form-item>

		<el-form-item label="Beszállító">
			<el-input
				v-model="form.supplierName"
				placeholder="Beszállító neve, ahogy az UNAS-ban szerepel"
			/>
		</el-form-item>

		<el-form-item label="Feed URL">
			<el-input
				v-model="form.feedUrl"
				placeholder="Ide másold az XLSX fájl url-jét"
			/>
		</el-form-item>

		<el-form-item label="Szinkron gyakorisága">
			<el-select v-model="form.frequency">
				<el-option
					v-for="opt in ['0', '5m', '12h', '24h', '48h', '72h', '168h']"
					:key="opt"
					:label="opt"
					:value="opt"
				/>
			</el-select>
		</el-form-item>

		<el-row :gutter="20">
			<el-col :span="12">
				<el-form-item label="Feed pénzneme">
					<el-select v-model="form.currency">
						<el-option
							v-for="opt in ['EUR', 'USD', 'HUF', 'CNY']"
							:key="opt"
							:label="opt"
							:value="opt"
						/>
					</el-select>
				</el-form-item>
			</el-col>
			<el-col :span="12">
				<el-form-item v-if="form.currency !== 'HUF'" label="Cél pénznem">
					<el-input v-model="form.targetCurrency" disabled placeholder="HUF" />
				</el-form-item>
			</el-col>
		</el-row>

		<!-- Raktárkészlet (küszöb) – az árképzés elé -->
		<el-form-item label="Raktárkészlet (küszöb)">
			<el-tooltip
				content="Ha a beszállítói készlet ennél kevesebb, akkor nem vásárolható az UNAS-ban."
				placement="top"
			>
				<el-input-number
					v-model="form.stockThreshold"
					:min="0"
					:step="1"
					style="max-width: 200px"
					placeholder="Pl. 3"
				/>
			</el-tooltip>
		</el-form-item>

		<el-divider></el-divider>

		<!-- Árképzés képlete: tagek az input prefixében, kattintással törlés -->
		<el-form-item label="Árképzés képlete">
			<div class="w-full">
				<el-input
					ref="pricingInputRef"
					v-model="pricingInputValue"
					readonly
					:placeholder="pricingPlaceholder"
					class="tag-input"
					@keydown.backspace.prevent="handleBackspace"
				>
					<template #prefix>
						<div class="tag-input-prefix" @click="focusInput">
							<el-tag
								v-for="(t, i) in pricingTokens"
								:key="i + '-' + t"
								size="small"
								:type="isOperator(t) ? 'info' : 'success'"
								class="clickable-tag"
								@click.stop="removeToken(i)"
							>
								{{ displayToken(t) }}
							</el-tag>
						</div>
					</template>
				</el-input>

				<!-- TOKEN GOMBOK -->
				<div class="token-toolbar">
					<div class="token-group">
						<span class="group-title">Változók:</span>
						<el-button
							size="small"
							:disabled="used.basePrice"
							@click="addToken('{basePrice}')"
							>Alapár</el-button
						>
						<el-button
							size="small"
							:disabled="used.discount"
							@click="addToken('{discount}')"
							>Kedvezmény</el-button
						>
						<el-button
							size="small"
							:disabled="used.priceMargin"
							@click="addToken('{priceMargin}')"
							>Árrés</el-button
						>
						<el-button
							size="small"
							:disabled="used.vat"
							@click="addToken('{vat}')"
							>ÁFA</el-button
						>
						<el-button
							size="small"
							:disabled="used.shipping"
							@click="addToken('{shipping}')"
							>Szállítás</el-button
						>
					</div>

					<div class="token-group">
						<span class="group-title">Műveletek:</span>
						<el-button size="small" @click="addToken('+')">+</el-button>
						<el-button size="small" @click="addToken('-')">−</el-button>
						<el-button size="small" @click="addToken('*')">×</el-button>
						<el-button size="small" @click="addToken('/')">÷</el-button>
						<el-button size="small" @click="addToken('(')">(</el-button>
						<el-button size="small" @click="addToken(')')">)</el-button>
					</div>
				</div>
			</div>
		</el-form-item>

		<el-form-item label="Áfa">
			<el-input-number
				v-model="form.vat"
				style="max-width: 150px"
				:min="0"
				:max="100"
				:value="form.vat"
			>
				<template #suffix><span>%</span></template>
			</el-input-number>
		</el-form-item>

		<el-form-item label="Árrés">
			<el-input-number
				style="max-width: 150px"
				v-model="form.priceMargin"
				:min="0"
			>
				<template #suffix><span>%</span></template>
			</el-input-number>
		</el-form-item>

		<el-form-item label="Kedvezmény">
			<el-input-number
				style="max-width: 150px"
				v-model="form.discount"
				:min="0"
			>
				<template #suffix><span>%</span></template>
			</el-input-number>
		</el-form-item>

		<el-form-item label="Szállítási költség">
			<div
				class="shipping-input"
				style="display: flex; justify-content: space-between; width: 250px"
			>
				<el-input-number
					v-model="form.shippingValue"
					:min="0"
					:step="100"
					:precision="0"
					controls-position="right"
					style="max-width: 150px"
				>
					<template #suffix><span>Ft</span></template>
				</el-input-number>

				<span
					v-if="shippingByWeight"
					class="mul-sign"
					style="position: relative"
					><el-icon
						style="
							position: absolute;
							top: 50%;
							transform: translateY(-50%) translateX(-50%);
							left: 100%;
						"
						><CloseBold /></el-icon
				></span>
				<el-checkbox-button
					v-model="shippingByWeight"
					@change="syncShippingType"
					class="weight-checkbox"
				>
					súly
				</el-checkbox-button>
			</div>
		</el-form-item>

		<el-form-item label="Kerekítés helyiértékre">
			<el-button-group>
				<el-button
					:type="form.rounding === 1 ? 'primary' : 'default'"
					@click="form.rounding = 1"
					>1</el-button
				>
				<el-button
					:type="form.rounding === 10 ? 'primary' : 'default'"
					@click="form.rounding = 10"
					>10</el-button
				>
				<el-button
					:type="form.rounding === 100 ? 'primary' : 'default'"
					@click="form.rounding = 100"
					>100</el-button
				>
			</el-button-group>
		</el-form-item>

		<el-divider></el-divider>
		
		<el-form-item
			label="Mezők hozzáadása"
			label-position="top"
			class="field-mapping"
		>
			<div
				v-for="(_, i) in mappingKeys"
				:key="i"
				class="mapping-row flex mb-2"
				:class="{
					'active-key-row': selectedKeyIndex === i,
					'active-price-row': fieldTypes[i] === 'price',
					'active-stock-row': fieldTypes[i] === 'stock',
					'active-weight-row': fieldTypes[i] === 'weight',
				}"
				style="margin-bottom: 1rem"
			>
				<el-row :gutter="20" style="width: 100%">
					<el-select
						v-model="fieldTypes[i]"
						size="default"
						style="width: 100px; margin-right: 8px"
						:class="'fieldtype-select ' + fieldTypes[i]"
						@change="onFieldTypeChange(i)"
						:popper-class="'fieldtype-popper'"
					>
						<el-option :value="'view'" label="Alap">
							<template #default>
								<el-icon><View /></el-icon> Alap
							</template>
						</el-option>
						<el-option :value="'key'" label="Kulcs">
							<template #default>
								<el-icon><Lock /></el-icon> Kulcs
							</template>
						</el-option>
						<el-option :value="'price'" label="Ár">
							<template #default>
								<el-icon><Money /></el-icon> Ár
							</template>
						</el-option>
						<el-option :value="'stock'" label="Készlet">
							<template #default>
								<el-icon><Box /></el-icon> Készlet
							</template>
						</el-option>
						<el-option :value="'weight'" label="Súly">
							<template #default
								><el-icon><TrendCharts /></el-icon> Súly
							</template>
						</el-option>
					</el-select>
					<el-select
						v-model="mappingKeys[i]"
						filterable
						remote
						:remote-method="onFeedFilter"
						:loading="feedFieldsLoading"
						:disabled="
							!feedFieldsLoading &&
							(Array.isArray(feedOptionsFiltered)
								? feedOptionsFiltered.length === 0
								: true)
						"
						placeholder="Feed mező keresése…"
						class="w-full"
						style="flex: 1"
						:class="'fieldtype-input ' + fieldTypes[i]"
					>
						<el-option
							v-for="opt in Array.isArray(feedOptionsFiltered)
								? feedOptionsFiltered
								: []"
							:key="opt.value"
							:label="opt.label"
							:value="opt.value"
						/>
					</el-select>
					<el-select
						v-model="mappingValues[i]"
						filterable
						remote
						:filter-method="onSelectFilter"
						:loading="unasFieldsLoading"
						placeholder="UNAS mező keresése…"
						class="w-full"
						style="flex: 1"
						:class="'fieldtype-input ' + fieldTypes[i]"
					>
						<el-option-group
							v-for="grp in Array.isArray(groupedOptionsFiltered)
								? groupedOptionsFiltered
								: []"
							:key="grp.label"
							:label="grp.label"
						>
							<el-option
								v-for="opt in Array.isArray(grp.options) ? grp.options : []"
								:key="opt.value"
								:label="opt.label"
								:value="opt.value"
							/>
						</el-option-group>
					</el-select>

					<el-button type="danger" icon="Delete" @click="removeMapping(i)" />
				</el-row>
			</div>
			<div
				style="
					display: flex;
					justify-content: center;
					margin-top: 1rem;
					width: 100%;
				"
			>
				<el-button type="primary" text @click="addMapping">
					<el-icon style="vertical-align: middle; margin-right: 4px"
						><Plus
					/></el-icon>
					<strong>Új mezők hozzáadása</strong>
				</el-button>

				<el-tooltip
					content="Ha változtak a mezők az UNAS-ban, akkor frissíteni kell"
					placement="top"
				>
					<el-button
						:loading="unasFieldsLoading"
						size="small"
						icon="Refresh"
						@click="refreshUnasFields"
						style="position: absolute; right: 10px; bottom: 10px"
					>
						UNAS mezők frissítése
					</el-button>
				</el-tooltip>
			</div>
		</el-form-item>


		<div class="hint" style="margin-bottom: 1rem">
			<el-icon size="large" style="vertical-align: middle; margin-right: 4px">
				<InfoFilled />
			</el-icon>
			Itt tudod összerendelni a feed mezőit az UNAS mezőkkel. A
			<strong
				><el-icon style="vertical-align: middle"><Lock /></el-icon>
				Kulcs</strong
			>
			selecttel jelölheted ki a kulcs mezőt, ami alapján az összerendelés
			történik.
		</div>

		<div style="padding: 20px; background: #f5f5f5" class="form-actions">
			<!-- <el-form-item style="margin-top: 20px">
				<el-switch
					v-model="form.dryRun"
					size="large"
					active-text="Teszt mód"
					inactive-text="Élő mód"
				/>
			</el-form-item> -->
			<el-form-item style="margin-top: 20px">
				<el-button size="large" @click="$emit('cancel')">Mégse</el-button>
				<el-button type="primary" size="large" @click="submit"
					>Mentés</el-button
				>
			</el-form-item>
		</div>
	</el-form>
</template>

<script>
	import {
		reactive,
		toRefs,
		toRef,
		ref,
		computed,
		nextTick,
		watch,
		onMounted,
	} from 'vue';
	import api from '../services/api';

	export default {
		name: 'ProcessForm',
		props: {
			show: { type: Boolean, required: false, default: false },
			shops: { type: Array, required: true },
			user: { type: Object, required: true },
			initial: { type: Object, required: true },
			activeShopId: { type: String, required: true, default: '' },
		},

		setup(props, { emit }) {
			const form = reactive({ vat: 27, stockThreshold: 1, ...props.initial });

			// --- Shipping state ---
			const shippingByWeight = ref((form.shippingType || 'fixed') === 'weight');

			// ha kezdetben nincs beállítva, adjunk defaultot
			if (!('shippingType' in form)) form.shippingType = 'fixed';
			if (typeof form.shippingValue !== 'number') form.shippingValue = 0;

			// checkbox váltásakor tartsuk szinkronban a form mezőt
			function syncShippingType() {
				form.shippingType = shippingByWeight.value ? 'weight' : 'fixed';
			}

			// Kulcs mező (keyField) kezelése
			const selectedKeyIndex = ref(0);
			// Ha van keyFields, állítsuk be a selectedKeyIndex-et a megfelelő mezőre
			function updateSelectedKeyIndex() {
				if (form.keyFields && form.keyFields.feed) {
					const idx = mappingKeys.findIndex((k) => k === form.keyFields.feed);
					if (idx !== -1) selectedKeyIndex.value = idx;
				}
			}

			// Aktív shop név
			const activeShopIdRef = toRef(props, 'activeShopId'); // reaktív
			const userRef = toRef(props, 'user');
			const showRef = toRef(props, 'show');
			const safeShopId = computed(() => String(activeShopIdRef.value || ''));

			const activeShopName = computed(() => {
				const s = (props.shops || []).find(
					(x) => x.shopId === safeShopId.value
				);
				return s ? s.name : safeShopId.value || '–';
			});

			let unasAbort = null;
			const unasMeta = reactive({ source: '', updatedAt: null });

			function formatDate(iso) {
				try {
					return new Date(iso).toLocaleString('hu-HU');
				} catch {
					return iso || '';
				}
			}

			async function loadUnasFields(shopId, processId, { force = false } = {}) {
				if (!shopId || !userRef.value) {
					unasOptions.value = [];
					return;
				}
				try {
					unasFieldsLoading.value = true;
					if (unasAbort) unasAbort.abort();
					unasAbort = new AbortController();

					const pid =
						(form.processId || props.initial.processId || '').trim() ||
						undefined;
					const resp = await api.getUnasFields(shopId, pid, {
						refresh: !!force,
						signal: unasAbort.signal,
					});
					const json = resp.data || {};

					// json.fields → cache vagy friss adat Firestore-ból
					let list = Array.isArray(json?.fields)
						? json.fields
								.map((f) =>
									typeof f === 'string' ? f : f.label ?? f.key ?? ''
								)
								.filter(Boolean)
						: [];

					// fallback CSV header maradhat, ha az API valaha így szolgáltatna
					if (list.length === 1 && /",".+","/.test(list[0])) {
						const headerLine = list[0];
						list = headerLine
							.replace(/^\s*"/, '')
							.replace(/"\s*$/, '')
							.split(/"\s*,\s*"/)
							.map((s) => s.trim())
							.filter(Boolean);
					}

					unasOptions.value = list.map((label) => ({
						label: String(label ?? '').trim(),
						value: String(label ?? '').trim(),
						_n: normalize(label),
					}));

					// meta
					unasMeta.source = json.source || '';
					unasMeta.updatedAt = json.updatedAt || null;
				} catch (e) {
					if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') return;
					console.error('UNAS mezők betöltése sikertelen:', e);
					// opcionális UX
					// ElMessage?.error?.('UNAS mezők betöltése sikertelen.');
				} finally {
					unasFieldsLoading.value = false;
				}
			}

			async function refreshUnasFields() {
				await loadUnasFields(
					safeShopId.value,
					form.processId || props.initial.processId,
					{ force: true }
				);
			}

			// ha a modál/komponens bezárul, állítsuk le a folyamatban lévő kérést:
			watch(showRef, (show) => {
				if (!show && unasAbort) {
					unasAbort.abort();
					unasAbort = null;
				}
			});

			// ---- Mapping állapot (NINCS kötelező default) ----
			// Megőrizzük a kulcsok sorrendjét, ha van fieldMappingOrder az initial-ban
			let initialMappingObj = { ...(form.fieldMapping || {}) };
			let keyOrder = Array.isArray(props.initial.fieldMappingOrder)
				? props.initial.fieldMappingOrder.filter((k) => k in initialMappingObj)
				: Object.keys(initialMappingObj);
			const mappingKeys = reactive([...keyOrder]);
			const mappingValues = reactive(
				mappingKeys.map((k) => initialMappingObj[k])
			);

			if (mappingKeys.length === 0) {
				// induljon egy üres sorral, hogy a felhasználó tudjon kezdeni
				mappingKeys.push('');
				mappingValues.push('');
			}
			// Ha a mappingKeys már megvan, próbáljuk beállítani a selectedKeyIndex-et
			updateSelectedKeyIndex();
			// Ha props.initial változik (pl. szerkesztéskor), frissítsük a mapping sorrendet és a selectedKeyIndex-et is
			watch(
				() => props.initial,
				() => {
					let newOrder = Array.isArray(props.initial.fieldMappingOrder)
						? props.initial.fieldMappingOrder.filter(
								(k) => k in form.fieldMapping
						  )
						: Object.keys(form.fieldMapping || {});
					mappingKeys.splice(0, mappingKeys.length, ...newOrder);
					mappingValues.splice(
						0,
						mappingValues.length,
						...newOrder.map((k) => form.fieldMapping[k])
					);
					updateSelectedKeyIndex();
					syncFieldTypes(); // <-- always recalc fieldTypes after config load
				},
				{ deep: true }
			);
			// Ha mappingKeys változik (pl. mező hozzáadás/törlés), mindig próbáljuk visszaállítani a selectedKeyIndex-et
			watch(mappingKeys, () => {
				updateSelectedKeyIndex();
			});

			// --- Field type state for each mapping row ---
			const fieldTypes = ref([]);

			function syncFieldTypes() {
				// 1. explicit típusok beállítása, ha vannak
				for (let i = 0; i < mappingKeys.length; ++i) {
					const feedKey = mappingKeys[i];
					const unasKey = mappingValues[i];
					// key
					if (
						form.keyFields &&
						form.keyFields.feed === feedKey &&
						form.keyFields.unas === unasKey
					) {
						fieldTypes.value[i] = 'key';
						continue;
					}
					// price
					if (
						form.priceFields &&
						form.priceFields.feed === feedKey &&
						form.priceFields.unas === unasKey
					) {
						fieldTypes.value[i] = 'price';
						continue;
					}
					// stock
					if (
						form.stockFields &&
						form.stockFields.feed === feedKey &&
						form.stockFields.unas === unasKey
					) {
						fieldTypes.value[i] = 'stock';
						continue;
					}
					// weight
					if (
						form.weightFields &&
						form.weightFields.feed === feedKey &&
						form.weightFields.unas === unasKey
					) {
						fieldTypes.value[i] = 'weight';
						continue;
					}
				}
				while (fieldTypes.value.length > mappingKeys.length)
					fieldTypes.value.pop();
			}
			// Init
			syncFieldTypes();
			// Keep fieldTypes in sync with mapping rows
			watch([mappingKeys, mappingValues], () => {
				syncFieldTypes();
			});
			// When a row is set to 'key', unset all others
			function onFieldTypeChange(idx) {
				if (fieldTypes.value[idx] === 'key') {
					fieldTypes.value.forEach((t, i) => {
						if (i !== idx && t === 'key') fieldTypes.value[i] = 'view';
					});
					selectedKeyIndex.value = idx;
				}
			}
			// If selectedKeyIndex changes, update fieldTypes
			watch(selectedKeyIndex, (idx) => {
				fieldTypes.value.forEach((t, i) => {
					if (i === idx) fieldTypes.value[i] = 'key';
					else if (t === 'key') fieldTypes.value[i] = 'view';
				});
			});

			const dryRun = ref(form.dryRun || false);

			// ---- UNAS mezőlista ----
			const unasAllFields = ref([]); // TELJES lista (string[])
			const unasFieldsLoading = ref(false);
			const unasOptions = ref([]); // { label, value, group }

			function normalize(s) {
				return String(s || '')
					.toLowerCase()
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, ''); // ékezetek nélkül
			}

			// Gyakran használt mezők listája
			const FREQUENT_MATCHERS = [
				(l) =>
					l.startsWith('paraméter: beszerzési helyen a cikkszáma') ||
					l.startsWith('parameter: beszerzesi helyen a cikkszama'),
				(l) => l === 'bruttó ár' || l === 'brutto ar',
				(l) => l === 'nettó ár' || l === 'netto ar',
				(l) => l === 'raktárkészlet' || l === 'raktarkeszlet',
				(l) =>
					l.startsWith('paraméter: súlya') || l.startsWith('parameter: sulya'),
			];

			function frequentRank(label) {
				const l = normalize(label);
				for (let i = 0; i < FREQUENT_MATCHERS.length; i++) {
					if (FREQUENT_MATCHERS[i](l)) return i; // 0..4
				}
				return -1; // nem gyakori
			}

			function isFrequent(label) {
				return frequentRank(label) >= 0;
			}

			const groupedOptions = computed(() => {
				const frequent = [];
				const others = [];

				for (const opt of unasOptions.value || []) {
					const r = frequentRank(opt.label);
					if (r >= 0) {
						frequent.push({ ...opt, _rank: r });
					} else {
						others.push(opt);
					}
				}

				// A „Gyakran használt” listán belül a megadott fix sorrend (rank szerint)
				frequent.sort((a, b) => a._rank - b._rank);

				// Két csoportos visszatérés a select-hez
				const groups = [];
				if (frequent.length) {
					groups.push({
						label: 'Gyakran használt',
						options: frequent.map(({ _rank, ...o }) => o),
					});
				}
				if (others.length) {
					groups.push({ label: 'Egyéb', options: others });
				}
				return groups;
			});

			const filterQuery = ref('');
			function onSelectFilter(query) {
				filterQuery.value = query || '';
			}

			const groupedOptionsFiltered = computed(() => {
				const q = normalize(filterQuery.value);
				const base = q
					? (unasOptions.value || []).filter((o) => o._n.includes(q))
					: unasOptions.value || [];

				const frequent = [];
				const others = [];
				for (const opt of base) {
					const r = frequentRank(opt.label);
					if (r >= 0) frequent.push({ ...opt, _rank: r });
					else others.push(opt);
				}
				frequent.sort((a, b) => a._rank - b._rank);

				const groups = [];
				if (frequent.length) {
					groups.push({
						label: 'Gyakran használt',
						options: frequent.map(({ _rank, ...o }) => o),
					});
				}
				if (others.length) {
					groups.push({ label: 'Egyéb', options: others });
				}
				return groups;
			});

			// Modal megnyitásakor töltünk csak, ha van user és shopId

			watch([showRef, userRef, safeShopId], ([show, user, shopId]) => {
				console.log('watcher fired', { show, user, shopId });
				if (props.show && userRef.value && form.shopId) {
					loadUnasFields(
						form.shopId,
						form.processId || props.initial.processId
					);
				} else if (!show) {
					unasOptions.value = [];
				}
			});

			onMounted(() => {
				console.log('onMounted', {
					show: props.show,
					user: userRef.value,
					shopId: form.shopId,
				});
				if (props.show && userRef.value && form.shopId)
					loadUnasFields(
						form.shopId,
						form.processId || props.initial.processId
					);
			});

			// ---- FEED mezőlista (CSV / XLSX / XML) ----
			const feedOptions = ref([]); // {label, value, _n}
			const feedOptionsFiltered = ref([]);
			const feedFieldsLoading = ref(false);
			const feedFilterQuery = ref('');

			function normalize(s) {
				return String(s || '')
					.toLowerCase()
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '');
			}

			async function loadFeedHeaders(url) {
				if (!url) {
					feedOptions.value = [];
					feedOptionsFiltered.value = [];
					return;
				}
				try {
					feedFieldsLoading.value = true;
					const resp = await api.getFeedHeaders(url);
					const json = resp.data;
					const list = Array.isArray(json?.fields)
						? json.fields
								.map((f) =>
									typeof f === 'string' ? f : f.label ?? f.key ?? ''
								)
								.filter(Boolean)
						: [];
					feedOptions.value = list.map((label) => {
						const s = String(label).trim();
						return { label: s, value: s, _n: normalize(s) };
					});
					// alap nézet: első 200 opció
					feedOptionsFiltered.value = feedOptions.value.slice(0, 200);
				} catch (e) {
					console.error('Feed mezők betöltése sikertelen:', e);
					feedOptions.value = [];
					feedOptionsFiltered.value = [];
				} finally {
					feedFieldsLoading.value = false;
				}
			}

			// select beépített kereső → csak állítsuk a query-t, szűrést mi végezzük
			function onFeedFilter(query) {
				feedFilterQuery.value = query || '';
				const q = normalize(feedFilterQuery.value);
				if (!q) {
					feedOptionsFiltered.value = (feedOptions.value || []).slice(0, 200);
				} else {
					feedOptionsFiltered.value = (feedOptions.value || [])
						.filter((o) => o._n.includes(q))
						.slice(0, 200);
				}
			}

			const feedUrlRef = toRef(form, 'feedUrl');
			let feedDebounceTimer = null;
			watch(
				[feedUrlRef, () => props.user],
				([url, user]) => {
					if (!user) return;
					clearTimeout(feedDebounceTimer);
					feedDebounceTimer = setTimeout(() => loadFeedHeaders(url), 500);
				},
				{ immediate: true }
			);

			// ---- Képlet tokenek ----
			const VAR_TOKENS = [
				'{basePrice}',
				'{discount}',
				'{priceMargin}',
				'{vat}',
				'{shipping}',
			];
			const OP_TOKENS = ['+', '-', '*', '/', '(', ')', ' '];
			const DISPLAY_MAP = {
				'{basePrice}': 'Alapár',
				'{discount}': 'Kedvezmény',
				'{priceMargin}': 'Árrés',
				'{vat}': 'ÁFA',
				'{shipping}': 'Szállítás',
				'+': '+',
				'-': '−',
				'*': '×',
				'/': '÷',
				'(': '(',
				')': ')',
				' ': '␣',
			};

			const pricingTokens = ref(textToTokens(form.pricingFormula || ''));
			const numberDraft = ref('');
			const pricingInputValue = ref('');
			const pricingPlaceholder = computed(() =>
				pricingTokens.value.length ? '' : 'Kattints a gombokra…'
			);
			const pricingInputRef = ref(null);

			const used = computed(() => ({
				basePrice: pricingTokens.value.includes('{basePrice}'),
				discount: pricingTokens.value.includes('{discount}'),
				priceMargin: pricingTokens.value.includes('{priceMargin}'),
				vat: pricingTokens.value.includes('{vat}'),
				shipping: pricingTokens.value.includes('{shipping}'),
			}));

			function displayToken(token) {
				if (/^\d+(?:\.\d+)?$/.test(token)) return token;
				return DISPLAY_MAP[token] ?? token;
			}
			function isOperator(t) {
				return OP_TOKENS.includes(t) || /^\d+(?:\.\d+)?$/.test(t);
			}
			function addToken(tok) {
				if (VAR_TOKENS.includes(tok) && pricingTokens.value.includes(tok))
					return;
				pricingTokens.value = [...pricingTokens.value, tok];
				focusInput();
			}
			function removeToken(index) {
				pricingTokens.value.splice(index, 1);
				focusInput();
			}
			function clearFormula() {
				pricingTokens.value = [];
				focusInput();
			}
			function handleBackspace() {
				if (pricingTokens.value.length > 0) {
					pricingTokens.value.pop();
				}
			}
			function addNumberDraft() {
				const v = (numberDraft.value || '').trim();
				if (!v) return;
				if (!/^\d+(\.\d+)?$/.test(v)) return;
				addToken(v);
				numberDraft.value = '';
			}
			function focusInput() {
				nextTick(() => {
					try {
						pricingInputRef.value?.focus?.();
					} catch {}
				});
			}

			// ---- Mapping kezelők ----
			function addMapping() {
				mappingKeys.push('');
				mappingValues.push('');
				// Új mező hozzáadásakor ne változzon a selectedKeyIndex, csak ha nincs már kijelölve érvényes mező
				if (selectedKeyIndex.value >= mappingKeys.length - 1) {
					selectedKeyIndex.value = 0;
				}
			}
			function removeMapping(index) {
				mappingKeys.splice(index, 1);
				mappingValues.splice(index, 1);
				// Ha a törölt index volt a kijelölt, vagy utána, állítsuk vissza az első érvényesre
				if (selectedKeyIndex.value >= mappingKeys.length) {
					selectedKeyIndex.value = 0;
				}
			}
			function submit() {
				const fm = {};
				const order = [];
				mappingKeys.forEach((k, i) => {
					const v = mappingValues[i];
					if (k && v) {
						fm[k] = v;
						order.push(k);
					}
				});
				form.fieldMapping = fm;
				form.fieldMappingOrder = order;

				// Kulcs, ár, készlet, súly mezőpárok mentése (mindegyikből max 1)
				// Kulcs mező
				form.keyFields = {
					feed: mappingKeys[selectedKeyIndex.value] || '',
					unas: mappingValues[selectedKeyIndex.value] || '',
				};
				// Ár mező (első price típusú sor)
				const priceIdx = fieldTypes.value.findIndex((t) => t === 'price');
				if (priceIdx !== -1) {
					form.priceFields = {
						feed: mappingKeys[priceIdx] || '',
						unas: mappingValues[priceIdx] || '',
					};
				} else {
					form.priceFields = { feed: '', unas: '' };
				}
				// Készlet mező (első stock típusú sor)
				const stockIdx = fieldTypes.value.findIndex((t) => t === 'stock');
				if (stockIdx !== -1) {
					form.stockFields = {
						feed: mappingKeys[stockIdx] || '',
						unas: mappingValues[stockIdx] || '',
					};
				} else {
					form.stockFields = { feed: '', unas: '' };
				}
				// Súly mező (első weight típusú sor)
				const weightIdx = fieldTypes.value.findIndex((t) => t === 'weight');
				if (weightIdx !== -1) {
					form.weightFields = {
						feed: mappingKeys[weightIdx] || '',
						unas: mappingValues[weightIdx] || '',
					};
				} else {
					form.weightFields = { feed: '', unas: '' };
				}

				form.pricingFormula = tokensToText(pricingTokens.value);

				form.shopId = safeShopId.value;

				// Csak akkor generálunk új processId-t, ha még nincs (új process)
				if (!form.processId || form.processId === '') {
					form.processId = `${props.activeShopId}_${new Date()
						.toISOString()
						.replace(/T/, '_')
						.replace(/:/g, '-')
						.slice(0, 19)}`;
				}
				// A processId-t mindig a Firestore doc id-jára kell állítani, hogy a listázás működjön
				emit('save', {
					...form,
					supplierName: form.supplierName,
					processId: form.processId,
				});
			}

			return {
				form,
				selectedKeyIndex,
				mappingKeys,
				mappingValues,
				removeMapping,
				addMapping,
				submit,
				activeShopName,
				activeShopId: safeShopId,
				fieldTypes,
				onFieldTypeChange,

				// UNAS mezőlista
				unasAllFields,
				unasFieldsLoading,
				unasOptions,
				groupedOptions,
				filterQuery,
				groupedOptionsFiltered,
				onSelectFilter,
				feedOptions,
				feedOptionsFiltered,
				feedFieldsLoading,
				onFeedFilter,
				refreshUnasFields,
				unasMeta,
				formatDate,

				// képlet UI
				pricingTokens,
				numberDraft,
				used,
				addToken,
				removeToken,
				clearFormula,
				addNumberDraft,
				isOperator,
				displayToken,
				pricingInputValue,
				pricingPlaceholder,
				pricingInputRef,
				handleBackspace,
				focusInput,
				syncShippingType,
				shippingByWeight,


			};
		},
	};

	// --- Segédfüggvények: tokenizálás/összefűzés ---
	function textToTokens(text) {
		if (!text) return [];
		const tokenRegex =
			/(\{basePrice\}|\{discount\}|\{priceMargin\}|\{vat\}|\{shipping\}|\+|\-|\*|\/|\(|\)|\s+|\d+(?:\.\d+)?)/g;
		const raw = text.match(tokenRegex) || [];
		return raw.filter((t) => t !== '');
	}
	function tokensToText(tokens) {
		return tokens.join('');
	}
</script>

<style scoped>
	/* Az input bal oldalán megjelenő tag-ek stílusa */
	.tag-input .el-input__prefix {
		display: block;
		width: 100%;
		height: auto;
		left: 0;
	}
	.tag-input-prefix {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		padding-left: 8px;
		padding-top: 6px;
		padding-bottom: 6px;
	}
	/* Az input belmagasságát növeljük, hogy több tag is elférjen */
	.tag-input .el-input__wrapper {
		min-height: 48px;
		align-items: flex-start;
		padding-top: 4px;
		padding-bottom: 4px;
	}
	/* Kattintható tag */
	.clickable-tag {
		cursor: pointer;
		user-select: none;
	}
	.clickable-tag:focus-visible {
		outline: 2px solid var(--el-color-primary);
	}
	.token-toolbar {
		margin-top: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.token-group {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.group-title {
		font-size: 12px;
		opacity: 0.85;
		margin-right: 6px;
	}
	.token-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.hint {
		background-color: var(--el-color-warning-light-8);
		border: 2px dashed var(--el-color-warning-light-3);
		padding: 0.5rem;
		margin-top: 1rem;
		font-size: 0.75rem;
	}
	/* Field type select and input coloring */
	.fieldtype-select.view,
	.fieldtype-input.view {
		background: none !important;
	}
	.fieldtype-select.key,
	.fieldtype-input.key {
		background: #e4fde4 !important;
		border: 1px solid #96ff96 !important;
	}
	.fieldtype-select.price,
	.fieldtype-input.price {
		background: #e4f0fd !important;
		border: 1px solid #96cfff !important;
	}
	.fieldtype-select.stock,
	.fieldtype-input.stock {
		background: #fffbe4 !important;
		border: 1px solid #ffe996 !important;
	}
	.fieldtype-select.weight,
	.fieldtype-input.weight {
		background: #eedbff !important;
		border: 1px solid #ce99ff !important;
	}
	.fieldtype-popper .el-select-dropdown__item.selected {
		font-weight: bold;
	}
	.shipping-input {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.mul-sign {
		font-weight: 600;
		user-select: none;
	}
	.unit {
		color: #666;
		font-size: 12px;
		margin-left: 4px;
	}
</style>

<style>
	.field-mapping > .el-form-item__label {
		display: flex !important;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 1rem;
		font-weight: bold;
		background: #cee4fc;
		margin-bottom: 0 !important;
		width: 100% !important;
		font-size: 1rem !important;
	}
	.field-mapping .el-form-item__content {
		padding: 2rem;
		background: #eee;
	}
	.field-mapping .mapping-row {
		width: 100%;
	}
	.field-mapping .mapping-row .el-row {
		display: flex;
		gap: 1rem;
		justify-content: space-between;
		margin: 0 !important;
		/* width: auto !important; */
	}
	.mapping-row.active-key-row .el-select__wrapper {
		background: #e4fde4 !important;
		transition: background 0.2s;
	}
	.mapping-row.active-price-row .el-select__wrapper {
		background: #e4f0fd !important;
		transition: background 0.2s;
	}
	.mapping-row.active-stock-row .el-select__wrapper {
		background: #fffbe4 !important;
		transition: background 0.2s;
	}
	.mapping-row.active-weight-row .el-select__wrapper {
		background: hsl(271, 100%, 93%) !important;
		transition: background 0.2s;
	}

	.form-actions {
		flex-wrap: nowrap;
	}
	.form-actions .el-form-item__content {
		margin-left: 0 !important;
	}
	.form-actions .el-form-item__content button {
		flex-grow: 1;
	}
	.weight-checkbox .el-checkbox-button__inner {
		border: 1px solid var(--el-border-color-light);
	}
</style>
