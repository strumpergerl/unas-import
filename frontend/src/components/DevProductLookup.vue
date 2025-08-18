<script setup>
import { ref, onMounted } from 'vue';
import axios from 'axios';

const shops = ref([]);
const form = ref({ shopId: '', sku: '', supplier: '', name: '', limit: 100 });
const loading = ref(false);
const error = ref('');
const results = ref([]);

onMounted(async () => {
  try {
    const { data } = await axios.get('/api/config');
    shops.value = data.shops || [];
    if (shops.value.length) form.value.shopId = shops.value[0].shopId;
  } catch (e) {
    error.value = 'Nem sikerült betölteni a shop listát.';
  }
});

async function runSearch() {
  error.value = '';
  results.value = [];
  if (!form.value.shopId) { error.value = 'Válassz shopot.'; return; }
  loading.value = true;
  try {
    const { data } = await axios.get('/api/dev/unas/products', {
      params: {
        shopId: form.value.shopId,
        sku: form.value.sku || undefined,
        supplier: form.value.supplier || undefined,
        name: form.value.name || undefined,
        limit: form.value.limit || 100,
      }
    });
    results.value = data.items || [];
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || 'Hiba a lekérdezésnél.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <h1 class="text-2xl font-semibold">UNAS terméklekérő (DEV)</h1>

    <div class="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
      <div>
        <label class="block text-sm font-medium mb-1">Webshop</label>
        <select v-model="form.shopId" class="w-full border rounded p-2">
          <option v-for="s in shops" :key="s.shopId" :value="s.shopId">
            {{ s.name || s.shopId }}
          </option>
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">SKU (pontos)</label>
        <input v-model="form.sku" class="w-full border rounded p-2" placeholder="pl. ABC-123" />
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">Beszállító</label>
        <input v-model="form.supplier" class="w-full border rounded p-2" placeholder="pl. Vevor" />
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">Terméknév</label>
        <input v-model="form.name" class="w-full border rounded p-2" placeholder="pl. fúró" />
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">Limit</label>
        <input v-model.number="form.limit" type="number" min="1" max="500" class="w-full border rounded p-2" />
      </div>

      <div class="md:col-span-5">
        <button @click="runSearch" :disabled="loading"
                class="px-4 py-2 rounded bg-black text-white disabled:opacity-50">
          {{ loading ? 'Lekérdezés...' : 'Keresés' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="text-red-600">{{ error }}</p>

    <div v-if="results.length" class="overflow-auto border rounded">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50">
          <tr>
            <th class="text-left p-2">SKU</th>
            <th class="text-left p-2">Név</th>
            <th class="text-left p-2">Beszállító</th>
            <th class="text-right p-2">Nettó ár</th>
            <th class="text-right p-2">Bruttó ár</th>
            <th class="text-right p-2">Készlet</th>
            <th class="text-left p-2">Státusz</th>
            <th class="text-left p-2">Módosítva</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in results" :key="row.sku" class="border-t">
            <td class="p-2 font-mono">{{ row.sku }}</td>
            <td class="p-2">{{ row.name }}</td>
            <td class="p-2">{{ row.supplier }}</td>
            <td class="p-2 text-right">{{ row.price ?? '' }}</td>
            <td class="p-2 text-right">{{ row.grossPrice ?? '' }}</td>
            <td class="p-2 text-right">{{ row.stock ?? '' }}</td>
            <td class="p-2">{{ row.status ?? '' }}</td>
            <td class="p-2">{{ row.updatedAt ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="!loading" class="text-gray-500">
      Nincs találat.
    </div>
  </div>
</template>
