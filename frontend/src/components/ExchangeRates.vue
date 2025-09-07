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

import api from '../services/api';


export default {
    name: 'ExchangeRates',    
  data() {
    return {
      rates: {},
      baseCurrency: 'HUF',
      refreshInterval: 60 * 60 * 1000, // 1 óra
    };
  },
  mounted() {
    this.loadRates();
    this.timer = setInterval(this.loadRates, this.refreshInterval);
  },
  beforeDestroy() {
    clearInterval(this.timer);
  },
  computed: {
    filteredRates() {
      return Object.entries(this.rates || {})
        .filter(([cur]) => cur !== this.baseCurrency)
        .map(([cur, rate]) => ({ cur, rate }));
    },
  },
  methods: {
    async loadRates() {
        try {
            const response = await api.getRates();
            this.rates = response.data.rates || {};
            console.log('Árfolyamok betöltve:', this.rates);
        } catch (error) {
            console.error('Hiba az árfolyamok betöltésekor:', error);
            if (this.$message && this.$message.error) {
                this.$message.error('Nem sikerült betölteni az árfolyamokat.');
            }
        }
    },
    formatRate(r) {
      return typeof r === 'number' && !isNaN(r) ? r.toFixed(2) : '-';
    },
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
