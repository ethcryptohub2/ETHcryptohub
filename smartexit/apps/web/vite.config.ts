import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/smartexit/apps/web/dist/',
  plugins: [react()],
  define: {
    global: 'globalThis',
    'process.env.DEFAULT_FINALITY': '"near-final"',
    'process.nextTick': 'queueMicrotask',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
        'process.env.DEFAULT_FINALITY': '"near-final"',
        'process.nextTick': 'queueMicrotask',
      },
    },
  },
  build: {
    manifest: true,
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
