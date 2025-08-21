<script setup>
import { ref } from 'vue';
import axios from 'axios';

const shopId = ref('shop1');
const skus = ref('ABC123,XYZ999');
const results = ref(null);
const error = ref(null);
const loading = ref(false);

async function fetchProducts() {
  loading.value = true;
  error.value = null;
  try {
    const { data } = await axios.get('/api/test/unas/products', {
      params: { shopId: shopId.value, skus: skus.value }
    });
    results.value = data;
  } catch (e) {
    error.value = e?.response?.data || e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="p-4 border rounded space-y-3">
    <h2 class="font-semibold">UNAS Teszt Terméklekérés</h2>
    <div class="flex gap-2">
      <input v-model="shopId" class="border px-2 py-1" placeholder="shopId" />
      <input v-model="skus" class="border px-2 py-1 flex-1" placeholder="SKU-k vesszővel" />
      <button @click="fetchProducts" :disabled="loading" class="bg-black text-white px-3 py-1 rounded">
        {{ loading ? 'Lekérés...' : 'Lekérés' }}
      </button>
    </div>

    <div v-if="error" class="text-red-600">
      <pre>{{ error }}</pre>
    </div>

    <div v-if="results">
      <p><b>Shop:</b> {{ results.shopId }} | <b>Találatok:</b> {{ results.count }}</p>
      <div v-for="r in results.results" :key="r.sku" class="border p-2 my-2">
        <b>SKU:</b> {{ r.sku }}
        <div v-if="r.ok">
          <details>
            <summary>Válasz</summary>
            <pre>{{ r.data }}</pre>
          </details>
        </div>
        <div v-else class="text-red-700">Hiba: {{ r.error }}</div>
      </div>
    </div>
  </div>
</template>
