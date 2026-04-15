import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev config. The Cloudflare Tunnel (cloudflared) points pay.karta.cards
// at this port, so allowedHosts must include the tunnel hostname. /api is
// proxied to the backend so the browser sees a single origin, which is what
// WebAuthn requires.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['pay.karta.cards', 'localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        // SSE needs proxy.bypass for long-lived connections
        ws: false,
      },
    },
  },
});
