// frontend/src/services/api.js
import axios from 'axios';
import { auth } from '../firestore';
import { ElLoading } from 'element-plus';

const base = import.meta.env.VITE_API_BASE_URL || '/api';

export const api = axios.create({
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
	// Csak akkor mutassuk a loadert, ha NEM Firestore Listen/Watch
	const isFirestoreListen =
		typeof config.url === 'string' &&
		config.url.includes('firestore.googleapis.com') &&
		(config.url.includes('/Listen') || config.url.includes('/Watch'));
	if (!isFirestoreListen) {
		activeRequests++;
		show();
	}
	return config;
});


api.interceptors.response.use(
	(resp) => {
		// Csak akkor csökkentsük a számlálót, ha nem Firestore Listen/Watch
		const isFirestoreListen =
			typeof resp.config?.url === 'string' &&
			resp.config.url.includes('firestore.googleapis.com') &&
			(resp.config.url.includes('/Listen') || resp.config.url.includes('/Watch'));
		if (!isFirestoreListen) {
			activeRequests--;
			if (activeRequests <= 0) activeRequests = 0;
			hide();
		}
		return resp;
	},
	(err) => {
		const isFirestoreListen =
			typeof err.config?.url === 'string' &&
			err.config.url.includes('firestore.googleapis.com') &&
			(err.config.url.includes('/Listen') || err.config.url.includes('/Watch'));
		if (!isFirestoreListen) {
			activeRequests--;
			if (activeRequests <= 0) activeRequests = 0;
			hide();
		}
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
