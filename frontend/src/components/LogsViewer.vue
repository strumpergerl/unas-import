<!-- frontend/src/components/LogsViewer.vue -->
<template>
  <div class="p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xl font-semibold">Folyamat logok</h2>
      <el-button :loading="loading" @click="load" type="primary" plain icon="Refresh">Frissítés</el-button>
    </div>

    <el-table
      :data="rows"
      v-loading="loading"
      border
      size="small"
      :default-sort="{ prop: 'startedAt', order: 'descending' }"
      row-key="id"
    >
      <el-table-column type="expand" width="40">
        <template #default="{ row }">
          <div class="p-2">
            <div class="mb-2 text-sm text-gray-600">
              <span class="mr-3">Run ID: <code>{{ row.id }}</code></span>
              <span v-if="row.error" class="text-red-600 font-medium">Hiba: {{ row.error }}</span>
            </div>

            <el-table :data="row.items" border size="small">
              <el-table-column label="#" type="index" width="50" />
              <el-table-column prop="action" label="Akció" width="90">
                <template #default="{ row: it }">
                  <el-tag :type="tagType(it.action)">{{ it.action }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="sku" label="SKU" min-width="140" />
              <el-table-column prop="key" label="Feed kulcs" min-width="160" />
              <el-table-column label="Változások" min-width="380">
                <template #default="{ row: it }">
                  <div v-if="hasChanges(it)" class="space-y-1">
                    <div v-for="(chg, name) in it.changes" :key="name" class="text-xs">
                      <strong>{{ prettyField(name) }}:</strong>
                      <span class="line-through text-gray-500 mr-1" v-if="chg.from !== null && chg.from !== undefined">
                        {{ chg.from }}
                      </span>
                      <span>→ {{ chg.to }}</span>
                    </div>
                  </div>
                  <div v-else class="text-xs text-gray-500 italic">Nincs változás (érték azonos maradt).</div>
                </template>
              </el-table-column>
              <el-table-column prop="error" label="Megjegyzés / Hiba" min-width="220">
                <template #default="{ row: it }">
                  <span v-if="it.error" class="text-red-600">{{ it.error }}</span>
                  <span v-else class="text-gray-500">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="processName" label="Process" min-width="180" />
      <el-table-column prop="shopName" label="Shop" min-width="140" />
      <el-table-column prop="startedAt" label="Indult" min-width="170">
        <template #default="{ row }">{{ fmt(row.startedAt) }}</template>
      </el-table-column>
      <el-table-column prop="finishedAt" label="Befejeződött" min-width="170">
        <template #default="{ row }">{{ fmt(row.finishedAt) }}</template>
      </el-table-column>
      <el-table-column prop="durationMs" label="Időtartam" width="110">
        <template #default="{ row }">{{ prettyMs(row.durationMs) }}</template>
      </el-table-column>

      <el-table-column label="Összesen" width="100" align="center">
        <template #default="{ row }">{{ row.counts?.output ?? row.counts?.input ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="Modify" width="90" align="center">
        <template #default="{ row }"><el-tag type="success">{{ row.counts?.modified || 0 }}</el-tag></template>
      </el-table-column>
      <el-table-column label="Skip" width="90" align="center">
        <template #default="{ row }"><el-tag type="warning">{{ (row.counts?.skippedNoKey||0) + (row.counts?.skippedNotFound||0) }}</el-tag></template>
      </el-table-column>
      <el-table-column label="Fail" width="90" align="center">
        <template #default="{ row }"><el-tag type="danger">{{ row.counts?.failed || 0 }}</el-tag></template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '../services/api';

const rows = ref([]);
const loading = ref(false);

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}
function prettyMs(ms) {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
function tagType(action) {
  if (action === 'modify') return 'success';
  if (action === 'fail') return 'danger';
  if (action === 'skip') return 'warning';
  return 'info';
}
function hasChanges(it) {
  return it && it.changes && Object.keys(it.changes).length > 0;
}
function prettyField(k) {
  const map = { price_net: 'Nettó ár', price_gross: 'Bruttó ár', stock: 'Készlet', name: 'Név', description: 'Leírás', currency: 'Pénznem' };
  return map[k] || k;
}
async function load() {
  loading.value = true;
  try {
    const { data } = await api.getLogs(); // GET /api/logs
    rows.value = Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Log betöltési hiba:', e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped>
.space-y-1 > * + * { margin-top: 0.25rem; }
</style>
