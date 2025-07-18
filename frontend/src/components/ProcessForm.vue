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

    <el-form-item label="Árazképzés képlete">
      <el-input
        v-model="form.pricingFormula"
        placeholder="Pl. {basePrice}-{discount}+{priceMargin}+{vat}"
      />
      <small>Változók: {basePrice}, {discount}, {priceMargin}, {vat}</small>
    </el-form-item>

    <el-form-item label="Áfa">
        <el-input-number v-model="form.vat" style="max-width: 150px" :min="0" :max="100" :value="form.vat">
            <template #suffix>
            <span>%</span>
        </template>
        </el-input-number>
    </el-form-item>

    <el-form-item label="Árrés">
      <el-input-number style="max-width: 150px" v-model="form.priceMargin" :min="0">
        <template #suffix>
            <span>%</span>
        </template>
      </el-input-number>
    </el-form-item>

    <el-form-item label="Kedvezmény">
      <el-input-number style="max-width: 150px" v-model="form.discount" :min="0" >
        <template #suffix>
            <span>%</span>
        </template>
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
            <el-switch
                v-model="dryRun"
                size="large"
                active-text="Élő mód"
                inactive-text="Teszt mód"
            />
        </el-form-item>
        <el-form-item style="margin-top: 20px;">
            <el-button type="primary" size="large" @click="submit">Mentés</el-button>
            <el-button  size="large" @click="$emit('cancel')">Mégse</el-button>
        </el-form-item>
    </div>
  </el-form>
</template>

<script>
import { reactive, toRefs } from "vue";


export default {
  name: "ProcessForm",
  props: {
    shops: { type: Array, required: true },
    initial: { type: Object, required: true },
  },
  setup(props, { emit }) {
    const form = reactive({ vat: 27, ...props.initial });
    const mappingKeys = reactive([...Object.keys(form.fieldMapping)]);
    const mappingValues = reactive([...Object.values(form.fieldMapping)]);
    const dryRun = reactive({ value: form.dryRun || false });

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
        shops: props.shops,
        dryRun: dryRun.value,
    };
  },
};
</script>
