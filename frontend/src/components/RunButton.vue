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
      try {
        console.log('Futás indítása folyamat:', this.id);
        const response = await api.runProcess(this.id)
        console.log('API válasz:', response)
        this.$emit('done', this.id)
      } catch (err) {
        console.error('API hiba:', err.response?.data || err)
        this.$message.error(
          `Hiba a futtatás során: ${err.response?.data?.error || err.message}`
        )
      } finally {
        this.loading = false
      }
    }
  }
};
</script>
