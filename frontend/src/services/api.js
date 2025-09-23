// frontend/src/services/api.js
import axios from 'axios';
import { auth } from '../firestore';
import { ElLoading } from 'element-plus';

const base = '/api';

export const api = axios.create({
	baseURL: base,
	headers: { 'Content-Type': 'application/json' },
	timeout: 120000, // 120s biztonsági zár
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
	const isFirestoreListen =
		typeof config.url === 'string' &&
		config.url.includes('firestore.googleapis.com') &&
		(config.url.includes('/Listen') || config.url.includes('/Watch'));
	const isFieldLoading =
		typeof config.url === 'string' &&
		(/\/unas\/fields/.test(config.url) || /\/feed\/headers/.test(config.url) || /\/rates$/.test(config.url));
	if (!isFirestoreListen && !isFieldLoading) {
		activeRequests++;
		show();
	}
	return config;
});

api.interceptors.response.use(
	(resp) => {
		// Csak akkor csökkentsük a számlálót, ha nem Firestore Listen/Watch ÉS NEM mezőbetöltő endpoint
		const isFirestoreListen =
			typeof resp.config?.url === 'string' &&
			resp.config.url.includes('firestore.googleapis.com') &&
			(resp.config.url.includes('/Listen') ||
				resp.config.url.includes('/Watch'));
		const isFieldLoading =
			typeof resp.config?.url === 'string' &&
			(/\/unas\/fields/.test(resp.config.url) || /\/feed\/headers/.test(resp.config.url) || /\/rates$/.test(resp.config.url));
		if (!isFirestoreListen && !isFieldLoading) {
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
		const isFieldLoading =
			typeof err.config?.url === 'string' &&
			(/\/unas\/fields/.test(err.config.url) ||
				/\/feed\/headers/.test(err.config.url));
		if (!isFirestoreListen && !isFieldLoading) {
			activeRequests--;
			if (activeRequests <= 0) activeRequests = 0;
			hide();
		}
		return Promise.reject(err);
	}
);

// 401 -> kijelentkeztet, vagy token refresh kísérlet
api.interceptors.response.use(
	(r) => r,
	async (err) => {
		if (err?.response?.status === 401) {
			try {
				await auth.signOut?.();
			} catch {}
		}
		return Promise.reject(err);
	}
);

export default {
	getConfig: () => api.get('/config'),
	saveConfig: (data) => api.post('/config', data),
	deleteConfig: (id) => api.delete(`/config/${id}`),
  	runProcess: (id, records, overrides = {}) =>
		api.post('/run', {
		processId: id,
		records,
		...overrides, // pl. { keyFields, priceFields, stockFields, dryRun }
		}),
	runProcessById: (id) => api.post('/run', { processId: id }),
	getLogs: () => api.get('/logs'),
	getRates: () => api.get('/rates'),
	getFeedHeaders: (url) => api.get('/feed/headers', { params: { url } }),
	getUnasFields: (shopId, processId) =>
		api.get('/unas/fields', { params: { shopId, processId } }),
};
