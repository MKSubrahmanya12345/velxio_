import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WireGI dev server.
//
//   Velxio (repo root frontend) :5173 · Forge :5174 · WireGI :5175
//
// `/api` is proxied to the WireGI express server (4322). The host is bound to
// 0.0.0.0 and any host header is accepted so the sandbox/preview proxy works.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4322',
        changeOrigin: true,
      },
    },
  },
});
