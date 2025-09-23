<!-- src/components/ExchangeRates.vue -->
<template>
  <div class="exchange-rates">
    <template v-if="Object.keys(rates).length">
      <span v-for="(item) in filteredRates" :key="item.cur">
        1 {{ item.cur }} = {{ formatRate(item.rate) }} {{ baseCurrency }}
      </span>
    </template>
    <span v-else>Árfolyam betöltése…</span>
  </div>
</template>

<script>
import { watch, onMounted, onBeforeUnmount } from 'vue';
import api from '../services/api';

export default {
  name: 'ExchangeRates',
  props: {
    user: { type: Object, default: null },
  },
  data() {
    return {
      rates: {},
      baseCurrency: 'HUF',
      refreshInterval: 60 * 60 * 1000, // 1 óra
      timer: null,
    };
  },
  computed: {
    filteredRates() {
      return Object.entries(this.rates || {})
        .filter(([cur]) => cur !== this.baseCurrency)
        .map(([cur, rate]) => ({ cur, rate }));
    },
  },
  methods: {
    async loadRates(retries = 5, delay = 500) {
      if (!this.user) return;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await api.getRates();
          this.rates = response.data.rates || {};
          console.log('Árfolyamok betöltve:', this.rates);
          return; // Sikeres betöltés esetén kilépünk
        } catch (error) {
          console.error(`Hiba az árfolyamok betöltésekor (próbálkozás ${attempt}):`, error);
          if (attempt === retries) {
            if (this.$message && this.$message.error) {
              this.$message.error('Nem sikerült betölteni az árfolyamokat.');
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    },
    formatRate(r) {
      return typeof r === 'number' && !isNaN(r) ? r.toFixed(2) : '-';
    },
  },
  mounted() {
    if (this.user) this.loadRates();
    this.timer = setInterval(() => {
      if (this.user) this.loadRates();
    }, this.refreshInterval);
    // Figyeljük a user változását is
    this.unwatchUser = watch(
      () => this.user,
      (newUser, oldUser) => {
        if (newUser && !oldUser) {
          this.loadRates();
        }
        if (!newUser) {
          this.rates = {};
        }
      }
    );
  },
  beforeUnmount() {
    clearInterval(this.timer);
    if (this.unwatchUser) this.unwatchUser();
  },
};
</script>

<style scoped>
.exchange-rates {
  background: #333;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #e0e0e0;
  font-size: 0.9rem;
  text-align: center;
  color: #e0e0e0;
}
.exchange-rates span {
  margin: 0 0.75rem;
}
</style>
