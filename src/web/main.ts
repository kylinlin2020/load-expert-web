import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { installErrorCapture } from './lib/errorCapture';
import { preloadLib } from './api/withReferenceLib';

const app = createApp(App);
app.use(router);
app.use(ElementPlus, { locale: zhCn });

/**
 * 在 mount **之前**装上错误捕获。
 *
 * 顺序有讲究：早一刻装上，就早一刻开始记录；晚装则可能漏掉
 * 路由守卫、组件 setup 阶段这类早期错误。
 */
installErrorCapture(app, router);

/**
 * 共享资料库预加载 —— 必须在 mount 之前
 *
 * 这样首屏的柜型/货物列表就已经含库里的条目，不用"先空着、加载完再刷新"地闪一下。
 * 未配置地址时这里立刻返回，**零开销、零行为变化**；
 * 拉取失败也静默降级（见 referenceStore 的取舍①），绝不挡住应用启动。
 */
void preloadLib();

app.mount('#app');