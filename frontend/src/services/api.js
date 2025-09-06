// frontend/src/services/api.js
import axios from 'axios';
import { auth } from '../firestore';
import { ElLoading } from 'element-plus';

const base = import.meta.env.VITE_API_BASE_URL || '/api';
const api = axios.create({
	baseURL: base,
	headers: { 'Content-Type': 'application/json' },
});

let loadingInstance = null;
let activeRequests = 0;
const show = () => {
	if (!loadingInstance)
		loadingInstance = ElLoading.service({
			fullscreen: true,
			text: 'Dolgozunk…',
		});
};
const hide = () => {
	if (loadingInstance && activeRequests === 0) {
		loadingInstance.close();
		loadingInstance = null;
	}
};

api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  activeRequests++;
  show();
  return config;
});

api.interceptors.response.use(
	(resp) => {
		activeRequests--;
		if (activeRequests <= 0) activeRequests = 0;
		hide();
		return resp;
	},
	(err) => {
		activeRequests--;
		if (activeRequests <= 0) activeRequests = 0;
		hide();
		return Promise.reject(err);
	}
);

export default {
	getConfig: () => api.get('/config'),
	saveConfig: (data) => api.post('/config', data),
	deleteConfig: (id) => api.delete(`/config/${id}`),
	runProcess: (id, records) =>
		api.post('/run', {
			processId: id,
			records,
		}),
	runProcessById: (id) => api.post('/run', { processId: id }),
	getLogs: () => api.get('/logs'),
	getRates: () => api.get('/rates'),
};
