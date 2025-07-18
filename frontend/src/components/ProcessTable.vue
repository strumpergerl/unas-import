<template>
  <div>
    <!-- Kereső mező -->
    <el-input
      v-model="search"
      placeholder="Keresés folyamat név vagy ID alapján"
      clearable
      style="width: 300px; margin-bottom: 16px;"
    />

    <!-- Táblázat testreszabott oszlopokkal -->
    <el-table
      :data="paginatedData"
      border
      stripe
      style="width: 100%"
    >
      <el-table-column
        prop="displayName"
        label="Megjelenített név"
        sortable
      />
      <el-table-column
        prop="processId"
        label="Process ID"
        sortable
      />
      <el-table-column
        prop="dryRun"
        label="Dry Run"
        :formatter="row => row.dryRun ? 'Igen' : 'Nem'"
      />
      <el-table-column label="Műveletek">
        <template #default="{ row }">
          <RunButton
            :id="row.processId"
            @done="onRunComplete"
          />
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

    // Ha keresési kifejezés változik, lapozás vissza az 1. oldalra
    watch(search, () => { currentPage.value = 1 })

    return { search, currentPage, pageSize, filtered, paginatedData, onRunComplete }
  }
}
</script>