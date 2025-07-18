<template>
  <button :disabled="loading" @click="run">
    {{ loading ? 'Futtatás…' : 'Futtatás' }}
  </button>
</template>

<script>
import api from '../services/api';

export default {
  props: ['id'],
  data: () => ({ loading: false }),
  methods: {
    async run() {
      this.loading = true;
      await api.runProcess(this.id);
      this.$emit('done', this.id);
      this.loading = false;
    }
  }
};
</script>
