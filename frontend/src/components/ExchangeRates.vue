<template>
  <div class="exchange-rates">
    <template v-if="Object.keys(rates).length">
      <span v-for="(rate, cur) in rates" :key="cur">
        1 {{ baseCurrency }} = {{ formatRate(rate) }} {{ cur }}
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
      refreshInterval: 10 * 60 * 1000, // 10 perc
    };
  },
  mounted() {
    this.loadRates();
    this.timer = setInterval(this.loadRates, this.refreshInterval);
  },
  beforeDestroy() {
    clearInterval(this.timer);
  },
  methods: {
    async loadRates() {
        try {
            const response = await api.getRates();
            // Feltételezve, hogy az árfolyamok a response.data.rates-ben vannak
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
  background: #fafafa;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #e0e0e0;
  font-size: 0.9rem;
  text-align: center;
}
.exchange-rates span {
  margin: 0 0.75rem;
}
</style>
