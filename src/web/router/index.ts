import { createRouter, createWebHistory } from 'vue-router';
import BoxesView from '../views/BoxesView.vue';
import ContainersView from '../views/ContainersView.vue';
import CalculateView from '../views/CalculateView.vue';
import PlansView from '../views/PlansView.vue';
import ReportView from '../views/ReportView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/boxes' },
    { path: '/boxes', component: BoxesView, meta: { title: '货物管理' } },
    { path: '/containers', component: ContainersView, meta: { title: '柜型管理' } },
    { path: '/calculate', component: CalculateView, meta: { title: '装柜计算' } },
    { path: '/report', component: ReportView, meta: { title: '装柜报表' } },
    { path: '/plans', component: PlansView, meta: { title: '方案列表' } },
  ],
});

export default router;
