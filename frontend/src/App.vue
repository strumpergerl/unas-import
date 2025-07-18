<template>
  <el-container>
    <el-header>
      <h1>Unas Importer Dashboard</h1>
      <ShopSelector v-model:shopId="selectedShop" :shops="shops" />ss
    </el-header>
    <el-main>
      <ProcessTable
        :processes="filteredProcesses"
        @run-complete="loadLogs"
      />
      <LogsViewer :logs="logs" />
    </el-main>
  </el-container>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import ShopSelector from './components/ShopSelector.vue'
import ProcessTable from './components/ProcessTable.vue'
import LogsViewer from './components/LogsViewer.vue'
import api from './services/api'

export default {
  components: { ShopSelector, ProcessTable, LogsViewer },
  setup() {
    const shops = ref([])
    const selectedShop = ref(null)
    const processes = ref([])
    const logs = ref([])

    const loadConfig = async () => {
      const res = await api.getConfig()
      shops.value = res.data.shops
      processes.value = res.data.processes
      if (!selectedShop.value && shops.value.length) {
        selectedShop.value = shops.value[0].shopId
      }
    }
    const loadLogs = async () => {
      const res = await api.getLogs()
      logs.value = res.data
    }

    const filteredProcesses = computed(() =>
      processes.value.filter(p => p.shopId === selectedShop.value)
    )

    onMounted(() => {
      loadConfig()
      loadLogs()
      setInterval(loadLogs, 5000)
    })

    return { shops, selectedShop, processes, logs, filteredProcesses, loadLogs }
  }
}
</script>