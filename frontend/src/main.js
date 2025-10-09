import { createApp } from 'vue';
import App from './App.vue';

// Element Plus importálása
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import { inject } from '@vercel/analytics';

const app = createApp(App);
// Globális komponensként regisztráljuk az Element Plus-t
app.use(ElementPlus);
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
	app.component(key, component);
}

if (import.meta.env.PROD) {
	// Only initialize analytics in production builds
	inject();
}

app.mount('#app');
