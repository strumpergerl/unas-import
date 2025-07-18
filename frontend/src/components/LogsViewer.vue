<template>
  <div class="logs">
    <pre>{{ logs.join('') }}</pre>
  </div>
</template>
<script>
export default {
  props: ['logs'],
  name: 'LogsViewer',
  setup(props) {
    // Any additional setup logic can go here
    return {
      logs: props.logs
    }
  }
}
</script>