<template>
  <el-form :model="form" label-width="200px">
    <el-form-item label="Folyamat neve">
      <el-input v-model="form.displayName" placeholder="Hogy könnyebben tudd azonosítani" />
    </el-form-item>

    <el-form-item label="Webshop választó">
      <el-select v-model="form.shopId" placeholder="Melyik webshophoz tartozik?">
        <el-option
          v-for="s in shops"
          :key="s.shopId"
          :label="s.name"
          :value="s.shopId"
        />
      </el-select>
    </el-form-item>

    <el-form-item label="Feed URL">
      <el-input v-model="form.feedUrl" placeholder="Ide másold az XLSX / XML / CSV fájl url-jét" />
    </el-form-item>

    <el-form-item label="Szinkron gyakorisága">
      <el-select v-model="form.frequency">
        <el-option v-for="opt in ['3h','6h','12h','24h']" :key="opt" :label="opt" :value="opt" />
      </el-select>
    </el-form-item>

    <el-row :gutter="20">
      <el-col :span="12">
        <el-form-item label="Feed pénzneme">
          <el-select v-model="form.currency">
            <el-option v-for="opt in ['EUR','USD','HUF','CNY']" :key="opt" :label="opt" :value="opt" />
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
      <el-input-number
        v-model="form.stockThreshold"
        :min="0"
        :step="1"
        style="max-width: 200px"
        placeholder="Pl. 3"
      />
      <small style="display:block; margin-top:6px;">
        Ha a feed készlet ennél kisebb, a termék ne legyen rendelhető.
      </small>
    </el-form-item>

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
        <el-button size="small" :disabled="used.basePrice" @click="addToken('{basePrice}')">Alapár</el-button>
        <el-button size="small" :disabled="used.discount" @click="addToken('{discount}')">Kedvezmény</el-button>
        <el-button size="small" :disabled="used.priceMargin" @click="addToken('{priceMargin}')">Árrés</el-button>
        <el-button size="small" :disabled="used.vat" @click="addToken('{vat}')">ÁFA</el-button>
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
      <el-input-number v-model="form.vat" style="max-width: 150px" :min="0" :max="100" :value="form.vat">
        <template #suffix><span>%</span></template>
      </el-input-number>
    </el-form-item>

    <el-form-item label="Árrés">
      <el-input-number style="max-width: 150px" v-model="form.priceMargin" :min="0">
        <template #suffix><span>%</span></template>
      </el-input-number>
    </el-form-item>

    <el-form-item label="Kedvezmény">
      <el-input-number style="max-width: 150px" v-model="form.discount" :min="0" >
        <template #suffix><span>%</span></template>
      </el-input-number>
    </el-form-item>

    <el-form-item label="Kerekítés helyiértékre">
      <el-button-group>
        <el-button :type="form.rounding === 1 ? 'primary' : 'default'" @click="form.rounding = 1">1</el-button>
        <el-button :type="form.rounding === 10 ? 'primary' : 'default'" @click="form.rounding = 10">10</el-button>
        <el-button :type="form.rounding === 100 ? 'primary' : 'default'" @click="form.rounding = 100">100</el-button>
      </el-button-group>
    </el-form-item>

    <el-form-item label="Mezők hozzáadása">
      <div v-for="(key, i) in mappingKeys" :key="i" class="flex mb-2" style="margin-bottom: 1rem;">
        <el-row :gutter="20">
          <el-col :span="11">
            <el-input v-model="mappingKeys[i]" placeholder="Feed mező neve" class="mr-2" />
          </el-col>
          <el-col :span="12">
            <el-input v-model="mappingValues[i]" placeholder="UNAS mező neve" />
          </el-col>
          <el-col :span="1">
            <el-button type="danger" icon="Delete" @click="removeMapping(i)" />
          </el-col>
        </el-row>
      </div>
      <el-button type="primary" link @click="addMapping">+ Új mező hozzáadása</el-button>
    </el-form-item>

    <div style="padding: 20px; background: #f5f5f5;">
      <el-form-item style="margin-top: 20px;">
        <el-switch v-model="form.dryRun" size="large" active-text="Teszt mód" inactive-text="Élő mód" />
      </el-form-item>
      <el-form-item style="margin-top: 20px;">
        <el-button type="primary" size="large" @click="submit">Mentés</el-button>
        <el-button size="large" @click="$emit('cancel')">Mégse</el-button>
      </el-form-item>
    </div>
  </el-form>
</template>

<script>
import { reactive, toRefs } from "vue";
import { ref, computed, nextTick } from "vue";

export default {
  name: "ProcessForm",
  props: {
    shops: { type: Array, required: true },
    initial: { type: Object, required: true },
  },
  
  setup(props, { emit }) {
    const form = reactive({ vat: 27, stockThreshold: 0, ...props.initial });
    const DEFAULT_MAPPINGS = {
      sku: "sku",
      price: "price",
      stock: "stock"
    };
    // initial fieldMapping összeolvasztása a kötelezőkkel
    const initialMapping = { ...DEFAULT_MAPPINGS, ...(form.fieldMapping || {}) };

    const mappingKeys = reactive([...Object.keys(initialMapping)]);
    const mappingValues = reactive([...Object.values(initialMapping)]);
    const dryRun = ref(form.dryRun || false);

    // ---- Képlet tokenek (belül: TECH tokenek; UI: magyar feliratok) ----
    const VAR_TOKENS = ["{basePrice}", "{discount}", "{priceMargin}", "{vat}"];
    const OP_TOKENS = ["+", "-", "*", "/", "(", ")", " "];

    // Token -> magyar felirat
    const DISPLAY_MAP = {
      "{basePrice}": "Alapár",
      "{discount}": "Kedvezmény",
      "{priceMargin}": "Árrés",
      "{vat}": "ÁFA",
      "+": "+",
      "-": "−",
      "*": "×",
      "/": "÷",
      "(": "(",
      ")": ")",
      " ": "␣" // opcionális: jelenítsük meg látható szóközként a badge-ben
    };

    const pricingTokens = ref(textToTokens(form.pricingFormula || ""));
    const numberDraft = ref("");

    // Üres input érték; placeholder dinamikus
    const pricingInputValue = ref("");
    const pricingPlaceholder = computed(() =>
      pricingTokens.value.length ? "" : "Kattints a gombokra…"
    );

    const pricingInputRef = ref(null);

    const used = computed(() => ({
      basePrice: pricingTokens.value.includes("{basePrice}"),
      discount: pricingTokens.value.includes("{discount}"),
      priceMargin: pricingTokens.value.includes("{priceMargin}"),
      vat: pricingTokens.value.includes("{vat}"),
    }));

    function displayToken(token) {
      // szám esetén maradjon szám; különben map-ből jön a magyar felirat
      if (/^\d+(?:\.\d+)?$/.test(token)) return token;
      return DISPLAY_MAP[token] ?? token;
    }

    function isOperator(t) {
      return OP_TOKENS.includes(t) || /^\d+(?:\.\d+)?$/.test(t);
    }
    function addToken(tok) {
      if (VAR_TOKENS.includes(tok) && pricingTokens.value.includes(tok)) return;
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
      const v = (numberDraft.value || "").trim();
      if (!v) return;
      if (!/^\d+(\.\d+)?$/.test(v)) return; // csak pozitív szám + opcionális tizedes
      addToken(v); // belül számként tároljuk; backend felé is így megy
      numberDraft.value = "";
    }
    function focusInput() {
      nextTick(() => {
        try {
          pricingInputRef.value?.focus?.();
        } catch {}
      });
    }

    // ---- /Képlet tokenek ----

    function addMapping() {
      mappingKeys.push("");
      mappingValues.push("");
    }
    function removeMapping(index) {
      mappingKeys.splice(index, 1);
      mappingValues.splice(index, 1);
    }

    function submit() {
      const fm = {};
      mappingKeys.forEach((k, i) => {
        if (k && mappingValues[i]) fm[k] = mappingValues[i];
      });
      form.fieldMapping = fm;

      // tokenek -> sztring (TECH tokenek!); pl. "{basePrice}*1.2+{vat}"
      form.pricingFormula = tokensToText(pricingTokens.value);

      if (!form.processId) {
        form.processId = `${form.shopId}_${new Date()
          .toISOString()
          .replace(/T/, '_')
          .replace(/:/g, '-')
          .slice(0, 19)}`;
      }
      emit("save", { ...form });
    }

    return {
      ...toRefs(form),
      form,
      mappingKeys,
      mappingValues,
      removeMapping,
      addMapping,
      submit,
      dryRun,

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
  const tokenRegex = /(\{basePrice\}|\{discount\}|\{priceMargin\}|\{vat\}|\+|\-|\*|\/|\(|\)|\s+|\d+(?:\.\d+)?)/g;
  const raw = text.match(tokenRegex) || [];
  return raw.filter(t => t !== "");
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
  display: block;
  font-size: 12px;
  opacity: 0.8;
}
</style>
