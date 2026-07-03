import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Pantrezy — Grocery Planner',
        short_name: 'Pantrezy',
        description: 'Recipe-first grocery planning with a time-vs-savings deal optimizer.',
        theme_color: '#166534',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Cache the active shopping list so it works in-store with no signal.
        runtimeCaching: [
          {
            urlPattern: /\/shopping-lists\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'active-list', networkTimeoutSeconds: 3 },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, host: true },
});
