<template>
	<el-form :model="form" label-width="200px">
		<el-form-item label="Folyamat neve">
			<el-input
				v-model="form.displayName"
				placeholder="Hogy könnyebben tudd azonosítani"
			/>
		</el-form-item>

		<el-form-item label="Webshop">
			<el-tag type="info">{{ activeShopName }}</el-tag>
		</el-form-item>

		<el-form-item label="Feed URL">
			<el-input
				v-model="form.feedUrl"
				placeholder="Ide másold az XLSX / XML / CSV fájl url-jét"
			/>
		</el-form-item>

		<el-form-item label="Szinkron gyakorisága">
			<el-select v-model="form.frequency">
				<el-option
					v-for="opt in ['3h', '6h', '12h', '24h', '48h', '72h', '168h']"
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
			<el-tooltip content="Csak azokat a termékeket importáljuk, amelyek raktárkészlete legalább ennyi." placement="top">
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
				:class="{ 'active-key-row': selectedKeyIndex === i }"
				style="margin-bottom: 1rem"
			>
				<el-row :gutter="20" style="width: 100%">
					<el-tooltip content="Kulcs mező (összerendeléshez)" placement="right">
						<el-button
							:type="selectedKeyIndex === i ? 'success' : 'default'"
							size="default"
							@click="selectedKeyIndex = i"
						>
							<el-icon><Lock /></el-icon>
						</el-button>
					</el-tooltip>
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
						:remote-method="onSelectFilter"
						:loading="unasFieldsLoading"
						placeholder="UNAS mező keresése…"
						class="w-full"
						style="flex: 1"
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
			<div style="display: flex; justify-content: center; margin-top: 1rem; width: 100%">
				<el-button type="primary" text @click="addMapping">
					<el-icon style="vertical-align: middle; margin-right: 4px;"><Plus /></el-icon>
					<strong>Új mezők hozzáadása</strong>
				</el-button>
			</div>
		</el-form-item>

		<div class="hint" style="margin-bottom: 1rem;">
			<el-icon size="large" style="vertical-align: middle; margin-right: 4px;">
				<InfoFilled />
			</el-icon>
			Itt tudod összerendelni a feed mezőit az UNAS mezőkkel. A <el-icon style="vertical-align: middle;"><Lock /></el-icon> gombbal jelölheted ki a kulcs mezőt, ami alapján az összerendelés történik.
		</div>

		<div style="padding: 20px; background: #f5f5f5">
			<el-form-item style="margin-top: 20px">
				<el-switch
					v-model="form.dryRun"
					size="large"
					active-text="Teszt mód"
					inactive-text="Élő mód"
				/>
			</el-form-item>
			<el-form-item style="margin-top: 20px">
				<el-button type="primary" size="large" @click="submit"
					>Mentés</el-button
				>
				<el-button size="large" @click="$emit('cancel')">Mégse</el-button>
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

	export default {
		name: 'ProcessForm',
		props: {
			shops: { type: Array, required: true },
			initial: { type: Object, required: true },
			activeShopId: { type: String, required: true, default: '' },
		},

		setup(props, { emit }) {
			const form = reactive({ vat: 27, stockThreshold: 1, ...props.initial });

			// Kulcs mező (keyField) kezelése
			const selectedKeyIndex = ref(0);

			// Aktív shop név
			const activeShopIdRef = toRef(props, 'activeShopId'); // reaktív
			const safeShopId = computed(() => String(activeShopIdRef.value || ''));

			const activeShopName = computed(() => {
				const s = (props.shops || []).find(
					(x) => x.shopId === safeShopId.value
				);
				return s ? s.name : safeShopId.value || '–';
			});

			// ---- Mapping állapot (NINCS kötelező default) ----
			const initialMappingObj = { ...(form.fieldMapping || {}) };
			const mappingKeys = reactive(Object.keys(initialMappingObj));
			const mappingValues = reactive(Object.values(initialMappingObj));

			if (mappingKeys.length === 0) {
				// induljon egy üres sorral, hogy a felhasználó tudjon kezdeni
				mappingKeys.push('');
				mappingValues.push('');
			}

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

			function detectGroup(label) {
				const l = normalize(label);

				// Paraméterek
				if (
					l.startsWith('parameter:') ||
					l.startsWith('paraméter:') ||
					l.startsWith('paramater:') ||
					l.includes('parameter|')
				)
					return 'Paraméterek';

				// Ár csoportok
				if (
					l.startsWith('ar:') ||
					l.startsWith('ár:') ||
					l.includes('ar tipus') ||
					l.includes('ár típus')
				)
					return 'Ár csoportok';

				// Alap mezők
				const baseKeys = [
					'cikkszam',
					'cikkszám',
					'termek nev',
					'termék név',
					'netto ar',
					'nettó ár',
					'brutto ar',
					'bruttó ár',
					'raktarkeszlet',
					'raktárkészlet',
					'kategoria',
					'kategória',
					'rovid leiras',
					'rövid leírás',
					'link',
					'kep',
					'kép',
					'seo',
					'sef url',
					'egyseg',
					'egység',
				];
				if (baseKeys.some((k) => l.includes(k))) return 'Alap mezők';

				return 'Egyéb';
			}

			async function loadUnasFields(shopId) {
				if (!shopId) {
					unasOptions.value = [];
					return;
				}
				try {
					unasFieldsLoading.value = true;
					const resp = await fetch(
						`/api/unas/fields?shopId=${encodeURIComponent(shopId)}`
					);
					const ct = resp.headers.get('content-type') || '';
					const bodyText = !ct.includes('application/json')
						? await resp.text().catch(() => '')
						: null;
					if (!resp.ok)
						throw new Error(
							`HTTP ${resp.status} – ${
								bodyText ? bodyText.slice(0, 200) : 'Hiba'
							}`
						);
					if (!ct.includes('application/json'))
						throw new Error(
							`Nem JSON válasz (Content-Type: ${ct}). Részlet: ${bodyText?.slice(
								0,
								200
							)}`
						);

					const json = await resp.json();

					// 1) listába szedjük (stringek)
					let list = Array.isArray(json?.fields)
						? json.fields
								.map((f) =>
									typeof f === 'string' ? f : f.label ?? f.key ?? ''
								)
								.filter(Boolean)
						: [];

					// 2) Fallback: ha egyben idézőzött CSV-sor jön, vágjuk el itt
					if (list.length === 1 && /",".+","/.test(list[0])) {
						const headerLine = list[0];
						list = headerLine
							.replace(/^\s*"/, '')
							.replace(/"\s*$/, '')
							.split(/"\s*,\s*"/)
							.map((s) => s.trim())
							.filter(Boolean);
					}

					// 3) Opciók + csoport címkézés
					unasOptions.value = list.map((label) => {
						const s = String(label ?? '').trim();
						return {
							label: s,
							value: s,
							group: detectGroup(s),
							_n: normalize(s),
						};
					});
				} catch (e) {
					console.error('UNAS mezők betöltése sikertelen:', e);
					unasOptions.value = [];
				} finally {
					unasFieldsLoading.value = false;
				}
			}

			// Csoportosított opciók (mindig újrarajzolja)
			const groupedOptions = computed(() => {
				const groups = new Map(); // label -> { label, options: [] }
				for (const opt of unasOptions.value) {
					if (!groups.has(opt.group))
						groups.set(opt.group, { label: opt.group, options: [] });
					groups.get(opt.group).options.push(opt);
				}
				// rendezzük: Alap mezők, Ár csoportok, Paraméterek, Egyéb
				const order = ['Alap mezők', 'Ár csoportok', 'Paraméterek', 'Egyéb'];
				return [...groups.values()].sort(
					(a, b) => order.indexOf(a.label) - order.indexOf(b.label)
				);
			});

			const filterQuery = ref('');

			function onSelectFilter(query) {
				filterQuery.value = query || '';
			}

			const groupedOptionsFiltered = computed(() => {
				const q = normalize(filterQuery.value);
				const list = q
					? unasOptions.value.filter((o) => o._n.includes(q))
					: unasOptions.value;

				const groups = new Map();
				for (const opt of list) {
					if (!groups.has(opt.group))
						groups.set(opt.group, { label: opt.group, options: [] });
					groups.get(opt.group).options.push(opt);
				}
				const order = ['Alap mezők', 'Ár csoportok', 'Paraméterek', 'Egyéb'];
				return [...groups.values()].sort(
					(a, b) => order.indexOf(a.label) - order.indexOf(b.label)
				);
			});

			// Modal megnyitáskor / shop váltáskor töltünk. NINCS megosztott filtered state.
			watch(
				safeShopId,
				(sid) => {
					if (sid) loadUnasFields(sid);
					else unasOptions.value = [];
				},
				{ immediate: true }
			);

			onMounted(() => {
				if (form.shopId) loadUnasFields(form.shopId);
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
					//const u = new URL(url); // hibát dob, ha érvénytelen
					const resp = await fetch(
						`/api/feed/headers?url=${encodeURIComponent(url)}`
					);
					const ct = resp.headers.get('content-type') || '';
					const bodyText = !ct.includes('application/json')
						? await resp.text().catch(() => '')
						: null;
					if (!resp.ok)
						throw new Error(
							`HTTP ${resp.status} – ${
								bodyText ? bodyText.slice(0, 200) : 'Hiba'
							}`
						);
					if (!ct.includes('application/json'))
						throw new Error(
							`Nem JSON válasz (Content-Type: ${ct}). Részlet: ${bodyText?.slice(
								0,
								200
							)}`
						);
					const json = await resp.json();
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
					feedOptionsFiltered.value = feedOptions.value.slice(0, 200);
				} else {
					feedOptionsFiltered.value = feedOptions.value
						.filter((o) => o._n.includes(q))
						.slice(0, 200);
				}
			}

			const feedUrlRef = toRef(form, 'feedUrl');
			let feedDebounceTimer = null;
			watch(
				feedUrlRef,
				(u) => {
					clearTimeout(feedDebounceTimer);
					feedDebounceTimer = setTimeout(() => loadFeedHeaders(u), 500);
				},
				{ immediate: true }
			);

			// ---- Képlet tokenek ----
			const VAR_TOKENS = [
				'{basePrice}',
				'{discount}',
				'{priceMargin}',
				'{vat}',
			];
			const OP_TOKENS = ['+', '-', '*', '/', '(', ')', ' '];
			const DISPLAY_MAP = {
				'{basePrice}': 'Alapár',
				'{discount}': 'Kedvezmény',
				'{priceMargin}': 'Árrés',
				'{vat}': 'ÁFA',
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
			}
			function removeMapping(index) {
				mappingKeys.splice(index, 1);
				mappingValues.splice(index, 1);
			}
			function submit() {
				const fm = {};
				mappingKeys.forEach((k, i) => {
					const v = mappingValues[i];
					if (k && v) fm[k] = v; // 1:1 mentés
				});
				form.fieldMapping = fm;

				// Kulcspár mentése
				form.keyFields = {
					feed: mappingKeys[selectedKeyIndex.value] || '',
					unas: mappingValues[selectedKeyIndex.value] || '',
				};

				form.pricingFormula = tokensToText(pricingTokens.value);

				form.shopId = safeShopId.value;

				if (!form.processId) {
					form.processId = `${props.activeShopId}_${new Date()
						.toISOString()
						.replace(/T/, '_')
						.replace(/:/g, '-')
						.slice(0, 19)}`;
				}
				emit('save', { ...form });
			}

			return {
				...toRefs(form),
				form,
				selectedKeyIndex,
				mappingKeys,
				mappingValues,
				removeMapping,
				addMapping,
				submit,
				dryRun,
				activeShopName,
				activeShopId: safeShopId,
				dryRun,
				activeShopName,
				activeShopId: safeShopId,

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
			};
		},
	};

	// --- Segédfüggvények: tokenizálás/összefűzés ---
	function textToTokens(text) {
		if (!text) return [];
		const tokenRegex =
			/(\{basePrice\}|\{discount\}|\{priceMargin\}|\{vat\}|\+|\-|\*|\/|\(|\)|\s+|\d+(?:\.\d+)?)/g;
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
	.hint{
		background-color: var(--el-color-warning-light-8);
		border: 2px dashed var(--el-color-warning-light-3);
		padding: .5rem;
		margin-top: 1rem;
		font-size: .75rem;
	}
</style>

<style>
	

	.field-mapping .el-form-item__label {
		align-items: center;
		justify-content: center;
		padding: 1rem;
		font-weight: bold;
		background: #cee4fc;
		margin-bottom: 0 !important;
	}
	.field-mapping .el-form-item__content {
		padding: 2rem;
		background: #eee;
	}
	.field-mapping .mapping-row {
		width: 100%;
	}
	.field-mapping .mapping-row .el-row{
		display: flex;
		gap: 1rem;
		justify-content: space-between;
		width: auto !important;
	}
	.mapping-row.active-key-row .el-select__wrapper {
		background: #e4fde4 !important;
		border: 1px solid #96ff96 !important;
		transition: background 0.2s;
	}
</style>
