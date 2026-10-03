import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router';
import BoxesView from '../views/BoxesView.vue';
import ContainersView from '../views/ContainersView.vue';
import CalculateView from '../views/CalculateView.vue';
import PlansView from '../views/PlansView.vue';
import ReportView from '../views/ReportView.vue';
import BackupView from '../views/BackupView.vue';
import AboutView from '../views/AboutView.vue';
import { IS_STATIC_BUILD } from '../api/client';

/**
 * 路由 history 模式按构建版本切换
 *
 * ## 静态版必须用 hash 模式
 *
 * GitHub Pages（以及绝大多数对象存储 / 静态托管）**不做 SPA 的 history fallback**：
 * 请求 `/仓库名/装柜计算` 会直接返回 404，而不是 index.html。
 * `createWebHistory()` 依赖服务端把所有路径都回落到 index.html，
 * 直接部署就会"刷新页面就白屏"。
 *
 * `createWebHashHistory()` 把路由放在 `#` 之后（`/#/calculate`），
 * 服务器永远只需要回一个 index.html —— 于是**同一份产物**在这些地方都能跑：
 * - GitHub Pages 项目站 `https://user.github.io/repo/`
 * - GitHub Pages 用户站 `https://user.github.io/`
 * - 对象存储的任意子目录 / 任何 CDN 路径
 * - 甚至直接双击打开本地 index.html（同源限制另说）
 *
 * 代价：URL 里多个 `#/`。对内部工具来说完全可以接受，
 * 而换来的是"部署到哪儿都不用改配置"。
 *
 * 服务端版仍用 history 模式（我们自己控制 nginx/后端，可以配 fallback），
 * URL 更干净。
 */
const history = IS_STATIC_BUILD ? createWebHashHistory() : createWebHistory();

const router = createRouter({
  history,
  routes: [
    { path: '/', redirect: '/boxes' },
    { path: '/boxes', component: BoxesView, meta: { title: '货物管理' } },
    { path: '/containers', component: ContainersView, meta: { title: '柜型管理' } },
    { path: '/calculate', component: CalculateView, meta: { title: '装柜计算' } },
    { path: '/report', component: ReportView, meta: { title: '装柜报表' } },
    { path: '/plans', component: PlansView, meta: { title: '方案列表' } },
    { path: '/backup', component: BackupView, meta: { title: '数据备份' } },
    { path: '/about', component: AboutView, meta: { title: '应用版本' } },
  ],
});

export default router;