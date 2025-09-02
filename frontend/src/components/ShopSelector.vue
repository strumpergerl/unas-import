<template>
  <el-select
    v-model="internalShopId"
    placeholder="Webshop kiválasztása"
    @change="onChange"
    style="width: 250px;"
  >
    <el-option
      v-for="s in shops"
      :key="s.shopId"
      :label="s.name"
      :value="s.shopId"
    />
  </el-select>
</template>

<script>
export default {
  name: 'ShopSelector',
  props: {
    shops: { type: Array, required: true },
    shopId: { type: String, default: null }
  },
  emits: ['update:shopId'],
  data() {
    return { internalShopId: this.shopId };
  },
  watch: {
    // Ha kívülről változik a shopId, szinkronizáljuk
    shopId(val) { this.internalShopId = val; }
  },
  methods: {
    onChange(val) {
      this.$emit('update:shopId', val);
    }
  }
};
</script>
