import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    proxy: { '/api': { target: 'http://localhost:8090', ws: true } },
  },
});
