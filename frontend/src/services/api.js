import axios from 'axios';

const api = axios.create({
  baseURL: '/api',         // a Vite-dev proxy vagy a backend statikus útvonal
  headers: { 'Content-Type': 'application/json' }
});

export default {
  getConfig:    () => api.get('/config'),
  runProcess:  (id) => api.post('/run', { processId: id }),
  getLogs:     () => api.get('/logs')
};
