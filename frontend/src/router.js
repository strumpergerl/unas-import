// frontend/src/router.js
import { createRouter, createWebHistory } from 'vue-router';
const DevProductLookup = () => import('./components/DevProductLookup.vue');

const routes = [
  { path: '/dev/unas-lookup', name: 'DevProductLookup', component: DevProductLookup },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
