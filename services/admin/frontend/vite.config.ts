import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dual-backend dev proxy (Phase 4d).
//
//   /api/*            → Vera admin (localhost:3005).  Owns vault-proxy,
//                        pay-proxy, tokenisation-programs, and the
//                        unauthenticated /api/capabilities probe.
//   /palisade-api/*   → Palisade admin (localhost:3009), rewritten to
//                        /api/* so the same route tree on both services
//                        stays ergonomic.  3009 keeps it clear of
//                        Palisade's data-prep (3006), rca (3007), and
//                        batch-processor (3008).
//
// The prod build expects a reverse proxy (Cloudflare or ALB rule on
// manage.karta.cards) to route the same two path prefixes to the two
// admin services — VITE_VERA_BASE_URL and VITE_PALISADE_BASE_URL can
// override both in exotic environments.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5176,
    allowedHosts: ['manage.karta.cards', 'localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3005',
        changeOrigin: false,
        ws: false,
      },
      '/palisade-api': {
        target: 'http://localhost:3009',
        changeOrigin: false,
        ws: false,
        rewrite: (p) => p.replace(/^\/palisade-api/, '/api'),
      },
    },
  },
});
