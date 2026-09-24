import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WireGI mobile chat app (WhatsApp-style, mobile-first).
//
//   Velxio (repo root frontend) :5173 · Forge :5174 · WireGI :5175 · WireGI mobile :5176
//
// `/api` is proxied to the WireGI express server (4322). Hotkey hint: run the
// mobile app with `npm run dev` in WireGI/mobile and open it on a phone via the
// TS server's LAN IP (host:port 5176) — the server binds 0.0.0.0.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5176,
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