import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        sidepanel: 'src/sidepanel/index.html',
        'inject/tiktok-handle': 'src/inject/tiktok-handle-inject.ts',
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'inject/tiktok-handle') return 'inject/tiktok-handle.js';
          return 'assets/[name]-[hash].js';
        },
        manualChunks: (id) => {
          if (id.includes('inject/tiktok-handle-inject')) return undefined;
          return undefined;
        },
      },
    },
  },
});
