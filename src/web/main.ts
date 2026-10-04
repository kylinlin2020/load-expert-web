import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { installErrorCapture } from './lib/errorCapture';

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

app.mount('#app');