import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Compile a fixed, self-contained classic script for the opaque-origin viewer. No CDN/CORS exception. */
function modelViewerBundle(mode: string): Plugin {
  let compiled: Promise<string> | undefined;
  return {
    name: 'oasis-model-viewer',
    resolveId: (id) => (id === 'virtual:oasis-model-viewer' ? '\0oasis-model-viewer' : undefined),
    async load(id) {
      if (id !== '\0oasis-model-viewer') return;
      compiled ??= build({
        configFile: false,
        mode,
        logLevel: 'error',
        build: {
          write: false,
          minify: true,
          lib: {
            entry: fileURLToPath(new URL('./src/canvas/model-viewer.ts', import.meta.url)),
            name: 'OasisModelViewer',
            formats: ['iife'],
          },
        },
      }).then((result) => {
        if ('on' in result) throw new Error('Viewer build unexpectedly entered watch mode');
        const outputs = Array.isArray(result) ? result : [result];
        const code = outputs
          .flatMap((item) => item.output)
          .filter((item) => item.type === 'chunk')
          .map((item) => item.code)
          .join('\n');
        if (!code) throw new Error('Fixed model viewer bundle missing');
        return code;
      });
      return `export default ${JSON.stringify(await compiled)}`;
    },
    handleHotUpdate(ctx) {
      if (ctx.file.endsWith('/canvas/model-viewer.ts') || ctx.file.endsWith('model-preview.ts')) {
        compiled = undefined;
        // 虚拟模块的转换结果缓存在模块图里，不清掉的话刷新页面拿到的还是旧查看器
        const cached = ctx.server.moduleGraph.getModuleById('\0oasis-model-viewer');
        if (cached) ctx.server.moduleGraph.invalidateModule(cached);
        ctx.server.ws.send({ type: 'full-reload' });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [react(), tailwindcss(), modelViewerBundle(mode)],
    server: {
      host: '127.0.0.1',
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      // 前端只和 gateway 打交道；开发时由 Vite 转发，避免跨域
      proxy: env.GATEWAY_URL ? { '/api': { target: env.GATEWAY_URL } } : undefined,
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
    },
  };
});
