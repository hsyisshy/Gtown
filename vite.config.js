import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Must be './' so asset paths in dist/ are relative,
  // required for AirConsole zip uploads (no domain root).
  base: './',

  build: {
    rollupOptions: {
      input: {
        controller: resolve(__dirname, 'controller.html'),
        screen: resolve(__dirname, 'screen.html'),
      },
    },
  },

  server: {
    host: true,
    port: 5173,
    // Allow all tunnel hosts (ngrok, cloudflared, etc.)
    allowedHosts: true,
  },
});
