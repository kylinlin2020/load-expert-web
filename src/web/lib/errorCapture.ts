/**
 * 全局错误捕获的安装
 *
 * 抽成独立文件是为了让 `main.ts` 保持清爽，也是为了让"装了什么"一目了然 ——
 * 漏装一类捕获是很容易发生且难以察觉的事。
 *
 * 捕获三类，缺一不可：
 *  1. **Vue 渲染/事件错误**（`app.config.errorHandler`）
 *  2. **未处理的 Promise 拒绝**（`unhandledrejection`）
 *     —— 少这一类最亏：视图里大量 `await api.xxx()`，一旦漏了 catch，
 *     界面上毫无反应，控制台也只有一条容易被忽略的警告
 *  3. **同步脚本错误**（`window.onerror`）—— 主要是资源加载失败
 */
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { recordError, recordAction, recordNav } from './diagnostics.js';

/** 页面路径 → 中文名，让轨迹更好读（不认识的路径原样保留） */
const ROUTE_NAMES: Record<string, string> = {
  '/boxes': '货物管理',
  '/containers': '柜型管理',
  '/calculate': '装柜计算',
  '/report': '装柜报表',
  '/plans': '方案列表',
  '/cases': '实测案例',
  '/backup': '数据备份',
  '/feedback': '意见反馈',
  '/about': '应用版本',
};

export function installErrorCapture(app: App, router: Router): void {
  // 1. Vue 错误
  app.config.errorHandler = (err, _instance, info) => {
    recordError(err, `Vue ${info}`);
    // 交给 console 保留原有可观测性（浏览器面板里还能看到）
    console.error('[LoadExpert]', info, err);
  };

  // 2. 未处理的 Promise 拒绝
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      recordError(ev.reason, '未处理的 Promise 拒绝');
      console.error('[LoadExpert] unhandledrejection', ev.reason);
    });

    // 3. 同步错误（含资源加载失败）
    window.addEventListener('error', (ev: ErrorEvent) => {
      // 资源加载失败时 ev.error 为 null，message 有内容
      recordError(ev.error ?? ev.message, ev.filename ? `脚本错误 @ ${ev.filename}:${ev.lineno}` : '脚本错误');
    });
  }

  // 4. 路由跳转轨迹
  router.afterEach((to, from) => {
    if (to.path === from.path) return;
    recordNav(`${ROUTE_NAMES[to.path] ?? to.path}${to.query.doc ? `?doc=${to.query.doc}` : ''}`);
  });

  // 5. 路由失败（动态 import 加载不到、导航被守卫拦截等）
  router.onError((err, to) => {
    recordError(err, `路由跳转失败 ${to.fullPath}`);
  });

  // 6. 卸载时兜底记一笔，便于诊断"是不是关页时出的问题"
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      recordAction('页面关闭');
    });
  }
}