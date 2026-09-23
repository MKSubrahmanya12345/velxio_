import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: forward /api to the WireGI server (default port 4322).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4322',
    },
  },
});
