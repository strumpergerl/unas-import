// frontend/src/services/api.js
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',         // a Vite-dev proxy vagy a backend statikus útvonal
  headers: { 'Content-Type': 'application/json' }
});


export default {
  getConfig:    () => api.get('/config'),
  saveConfig:   (data) => api.post('/config', data),
  deleteConfig: (id) => api.delete(`/config/${id}`),
  runProcess:  (id, records) => api.post('/run', {
    processId: id,
    records
  }),
  runProcessById: (id) => api.post('/run', { processId: id }),
  getLogs:     () => api.get('/logs'),
  getRates:    () => api.get('/rates')
};

