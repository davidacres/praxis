import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rolldownOptions: {
      input: ['index.html', 'tauri.html']
    },
    outDir: 'dist'
  }
});
