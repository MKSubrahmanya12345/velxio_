import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode: the Vite server proxies /api to the Forge API server, so the
// browser always talks to one origin (same as production, where Express
// serves the built client directly).
const apiTarget = process.env.VITE_API_PROXY || 'http://localhost:4321';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
