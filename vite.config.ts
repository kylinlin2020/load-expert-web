import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 前端走同源 /api，由 Vite 转发到后端，避免 localhost IPv6/IPv4 解析差异导致连不上后端
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 与后端 tsc 产物 dist/ 共存，输出到 dist/web 子目录
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
