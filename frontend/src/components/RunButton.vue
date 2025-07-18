<template>
  <el-tooltip placement="top">
    <template #content> Azonnali indítás </template>
    <el-button :disabled="loading" @click="run" type="primary" circle size="large">
      <el-icon size="25"><VideoPlay /></el-icon>
    </el-button>
  </el-tooltip>
</template>
  

<script>
import api from '../services/api';

export default {
  props: ['id'],
  data: () => ({ loading: false }),
  methods: {
    async run() {
      this.loading = true;
      await api.runProcess(this.id);
      this.$emit('done', this.id);
      this.loading = false;
    }
  }
};
</script>
