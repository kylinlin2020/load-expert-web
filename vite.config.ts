import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 两套构建产物
 *
 * | 命令 | mode | base | 路由 | 用途 |
 * |---|---|---|---|---|
 * | `npm run build:web` | production | `/` | history | 服务端版，需后端 |
 * | `npm run build:web:static` | **static** | **`./`** | hash | 纯静态版，扔哪都能跑 |
 *
 * ## 为什么静态版 base 用相对路径 `./`
 *
 * 同一份产物要能在**未知的前缀**下工作：GitHub Pages 项目站在 `/仓库名/`、
 * 用户站在 `/`、对象存储可能在 `/some/deep/path/`。
 * 绝对 base（`/` 或 `/仓库名/`）每换一个地方就要重新构建；
 * 相对 base 让 index.html 里所有资源引用都相对于**当前 HTML 所在目录**，
 * 于是同一份产物直接可用，不需要知道部署到哪个路径。
 *
 * 配合 hash 路由（见 src/web/router/index.ts 的说明），静态版就是"扔哪都能跑"。
 */
export default defineConfig(({ mode }) => {
  const isStatic = mode === 'static';
  return {
    plugins: [vue()],
    base: isStatic ? './' : '/',

    /**
     * 「提交 Issue」用的仓库地址
     *
     * 刻意给一个默认值而不是只读 `VITE_ISSUE_REPO`：
     * 后者只能来自 `.env`，而 `.env` 已 gitignore —— 那样**部署出去的静态版
     * 会永远拿不到地址，Issue 按钮一直是灰的**，等于这个功能上线即失效。
     *
     * 用 `define` 注入而非 `import.meta.env` 的原因：Vite 只把 `.env` 里的
     * `VITE_*` 暴露给 `import.meta.env`，而 CI 里没有 `.env`。
     * `define` 是构建期字面量替换，CI / 本地 / fork 都能生效。
     * 需要指向自己仓库时用环境变量 `VITE_ISSUE_REPO` 覆盖即可。
     */
    define: {
      'import.meta.env.VITE_ISSUE_REPO': JSON.stringify(
        process.env.VITE_ISSUE_REPO ?? 'https://github.com/kylinlin2020/load-expert-web',
      ),
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        // 前端同源 /api 由 Vite 作为代理，避免浏览器把 localhost 解析成 ::1
        // 而后端仅监听 IPv4 导致的连接失败
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
    build: {
      // 先 tsc 编译到 dist/，再 vite 打包到 dist/web 目录
      outDir: 'dist/web',
      emptyOutDir: true,
    },
  };
});