import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../version-cpanel/react-dist',
    emptyOutDir: true,
    manifest: 'manifest.json',
  },
});
