<template>
  <div>
    <!-- Táblázat testreszabott oszlopokkal -->
    <el-table
      :data="paginatedData"
      border
      stripe
      style="width: 100%"
    >
      <el-table-column
        width="80"
        prop="processId"
        :label="'ID'"
        sortable
        show-overflow-tooltip
      />
      <el-table-column
        prop="displayName"
        label="Szinkron folyamat neve"
        sortable
      />
      
      <!-- Műveletek oszlop run gombbal: explicit default slot -->
      <el-table-column label="Műveletek" width="200">
        <template #default="scope">
          <RunButton
            :id="scope.row.processId"
            @done="onRunComplete(scope.row.processId)"
          />
          <el-tooltip placement="top">
            <template #content> Konfiguráció módosítása </template>
            <el-button @click="$emit('edit', scope.row.processId)" type="primary" circle size="large">
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
      v-if="filtered.length > pageSize"
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
  emits: ['run-complete', 'edit', 'delete'],
  setup(props, { emit }) {
    const search = ref('')
    const currentPage = ref(1)
    const pageSize = 10

    const filtered = computed(() => {
      const term = search.value.toLowerCase()
      return (props.processes || []).filter(p =>
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