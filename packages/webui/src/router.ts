import { createRouter, createWebHashHistory } from 'vue-router';
import { modules } from './modules';

/** hash 路由:Electron 内嵌 file:// 与 Fastify 静态托管都兼容 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    ...modules.map(m => ({ path: m.path, component: m.view })),
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
});
