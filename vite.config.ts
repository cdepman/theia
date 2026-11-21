import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In local development the API and the access gate run in server/dev-server.ts.
const api = `http://127.0.0.1:${process.env.THEIA_API_PORT ?? 8788}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api },
  },
  build: { target: 'es2022', sourcemap: false },
});
