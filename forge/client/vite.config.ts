import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode: the Vite server proxies /api to the Forge API server, so the
// browser always talks to one origin (same as production, where Express
// serves the built client directly).
const apiTarget = process.env.VITE_API_PROXY || 'http://localhost:4321';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // Arena serves the dev app through a generated preview hostname.
    // Vite otherwise rejects that host with HTTP 403 before React loads.
    allowedHosts: true,
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
