<!-- src/components/RunButton.vue -->
<template>
  <el-tooltip placement="top">
    <template #content> Azonnali indítás </template>
    <el-button :disabled="loading || !id" @click="run" type="success" circle size="large">
      <el-icon size="25"><VideoPlay /></el-icon>
    </el-button>
  </el-tooltip>
</template>
  

<script lang="js">
import api from '../services/api';
import { ElMessage } from 'element-plus';
import { VideoPlay } from '@element-plus/icons-vue';

export default {
  props: {
    id: String,
    records: { type: Array, default: () => [] }
  },
  components: {
    VideoPlay
  },
  data: () => ({ loading: false }),
  methods: {
    async run() {
      if (!this.id) return;
      this.loading = true;
      try {
        console.log('Futás indítása folyamat:', this.id, 'rekordok:', this.records);
        const response = await api.runProcessById(this.id);
        console.log('API válasz:', response)
        ElMessage.success('Futás elindítva');
        this.$emit('done', this.id)
      } catch (err) {
        console.error('API hiba:', err.response?.data || err)
        ElMessage.error(
          `Hiba a futtatás során: ${err.response?.data?.error || err.message}`
        )
      } finally {
        this.loading = false
      }
    }
  }
}
</script>
