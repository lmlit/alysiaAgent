import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发:Vite dev server(5173)代理 /api → 本地后端(6185)
// 生产:pnpm build 后由 Fastify 同源托管(server 内嵌 webui 静态目录)
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.ALYSIA_API ?? 'http://127.0.0.1:6185',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: 'index.html',
        pet: 'pet.html',
      },
    },
  },
});
