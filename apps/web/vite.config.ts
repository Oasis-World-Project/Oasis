import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      // 前端只和 gateway 打交道；开发时由 Vite 转发，避免跨域
      proxy: env.GATEWAY_URL ? { '/api': { target: env.GATEWAY_URL } } : undefined,
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.tsx'],
      setupFiles: ['test/setup.ts'],
    },
  };
});
