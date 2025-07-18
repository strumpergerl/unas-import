<template>
  <div>
    <!-- Kereső mező -->
    <!-- <el-input
      v-model="search"
      placeholder="Keresés folyamat név vagy ID alapján"
      clearable
      style="width: 300px; margin-bottom: 16px;"
    /> -->

    <!-- Táblázat testreszabott oszlopokkal -->
    <el-table
      :data="paginatedData"
      border
      stripe
      style="width: 100%"
    >
      <el-table-column
      width="200"
        prop="processId"
        label="ID"
        sortable
      />
      <el-table-column
        prop="displayName"
        label="Szinkron folyamat neve"
        sortable
      />
      <el-table-column
        width="100"
        prop="dryRun"
        label="Élő mód"
      >
        <template #default="scope" >
            <el-icon style="vertical-align: middle; margin-right: 4px;" size="25">
              <template v-if="!scope.row.dryRun">
                <CircleCheckFilled style="color: #67C23A;" />
              </template>
              <template v-else>
                <CircleCloseFilled style="color: #F56C6C;" />
              </template>
            </el-icon>
            {{ !scope.row.dryRun ? 'Igen' : 'Nem' }}
        </template>
      </el-table-column>
      <!-- Műveletek oszlop run gombbal: explicit default slot -->
      <el-table-column label="Műveletek" width="200">
        <template #default="scope">
          <RunButton
            :id="scope.row.processId"
            @done="onRunComplete(scope.row.processId)"
          />
          <el-tooltip placement="top">
            <template #content> Konfiguráció módosítása </template>
            <el-button @click="$emit('edit', scope.row.processId)" type="info" circle size="large">
              <el-icon  size="25"><EditPen /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip placement="top">
            <template #content> Konfiguráció törlése </template>
            <el-button @click="$emit('delete', scope.row.processId)" type="danger" circle size="large">
              <el-icon size="25"><Delete /></el-icon>
            </el-button>
          </el-tooltip>

        </template>
      </el-table-column>
    </el-table>

    <!-- Lapozás -->
    <el-pagination
      background
      style="margin-top: 16px; text-align: right;"
      layout="prev, pager, next"
      :page-size="pageSize"
      v-model:current-page="currentPage"
      :total="filtered.length"
    />
  </div>
</template>

<script>
import RunButton from './RunButton.vue'
import { ref, computed, watch } from 'vue'

export default {
  name: 'ProcessTable',
  props: {
    processes: { type: Array, default: () => [] }
  },
  components: { RunButton },
  emits: ['run-complete'],
  setup(props, { emit }) {
    const search = ref('')
    const currentPage = ref(1)
    const pageSize = 10

    const filtered = computed(() => {
      const term = search.value.toLowerCase()
      return props.processes.filter(p =>
        p.displayName.toLowerCase().includes(term) ||
        p.processId.toLowerCase().includes(term)
      )
    })

    const paginatedData = computed(() => {
      const start = (currentPage.value - 1) * pageSize
      return filtered.value.slice(start, start + pageSize)
    })

    function onRunComplete(id) {
      emit('run-complete', id)
    }

    watch(search, () => { currentPage.value = 1 })

    return {
      search,
      currentPage,
      pageSize,
      filtered,
      paginatedData,
      onRunComplete
    }
  }
}
</script>