import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// DEPLOY_BASE is injected by scripts/deploy-cpanel.mjs so production assets
// resolve under /slysplit/. Dev serves from root.
export default defineConfig({
  base: process.env.DEPLOY_BASE ?? '/',
  plugins: [react()],
  server: {
    port: 8000,
    proxy: {
      '/api': 'http://127.0.0.1:8100',
    },
  },
});
