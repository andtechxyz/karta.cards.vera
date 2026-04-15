import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5176,
    allowedHosts: ['admin.karta.cards', 'localhost'],
    proxy: {
      // Admin API (programs CRUD, card PATCH)
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
      // Vault service (card list, vault store, audit)
      '/api/vault': {
        target: 'http://localhost:3004',
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
