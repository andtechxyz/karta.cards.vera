import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5176,
    allowedHosts: ['manage.karta.cards', 'localhost'],
    proxy: {
      // Admin API — programs CRUD, card PATCH, and the vault proxy that
      // signs HMAC requests to the vault service on the browser's behalf.
      '/api/programs': {
        target: 'http://localhost:3005',
        changeOrigin: false,
        ws: false,
      },
      '/api/cards': {
        target: 'http://localhost:3005',
        changeOrigin: false,
        ws: false,
      },
      '/api/admin': {
        target: 'http://localhost:3005',
        changeOrigin: false,
        ws: false,
      },
      // Pay service (transactions)
      '/api/transactions': {
        target: 'http://localhost:3003',
        changeOrigin: false,
        ws: false,
      },
    },
  },
});
