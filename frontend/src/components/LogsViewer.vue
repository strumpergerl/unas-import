<template>
  <div class="logs">
    <pre>{{ logs.join('') }}</pre>
  </div>
</template>
<script>
export default {
  props: ['logs']
}
</script>