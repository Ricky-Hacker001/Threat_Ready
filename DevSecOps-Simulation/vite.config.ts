import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'] },
  server: { port: 5180 },
});
