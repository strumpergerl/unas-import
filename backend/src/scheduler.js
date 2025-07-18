const cron = require('node-cron');
const { runProcessById } = require('./runner');

/**
 * A processes.json mezőiben definiált frequency értékek (pl. '30m','3h','1d')
 * -> cron kifejezésekre konvertálása.
 */
function cronExpression(freq) {
  const num = parseInt(freq.slice(0, -1), 10);
  const unit = freq.slice(-1);
  switch (unit) {
    case 'm': return `*/${num} * * * *`;
    case 'h': return `0 */${num} * * *`;
    case 'd': return `0 0 */${num} * *`;
    default: throw new Error(`Unsupported frequency: ${freq}`);
  }
}

/**
 * Minden process ütemezése.
 */
function scheduleProcesses(processes) {
  processes.forEach(proc => {
    const expr = cronExpression(proc.frequency);
    cron.schedule(expr, () => {
      console.log(`Ütemezett futtatás: ${proc.displayName}`);
      runProcessById(proc.processId);
    });
  });
}

module.exports = { scheduleProcesses };