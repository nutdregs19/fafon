import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

// Local test data: FAFON_DATA=<folder> serves files found there (and its manifest-merged.json as
// the manifest); everything else still comes from the live site through the proxy below.
function localData(): Plugin {
  const dir = process.env.FAFON_DATA;
  return {
    name: 'fafon-local-data',
    configureServer(server) {
      if (!dir) return;
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/data/')) return next();
        const rel = url === '/data/manifest.json' ? 'manifest-merged.json' : decodeURIComponent(url.slice(6));
        const file = path.resolve(dir, rel);
        if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'image/png');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  // local preview shows the same forecast data as the live site (no multi-GB download on this PC)
  server: {
    proxy: {
      '/data': { target: 'https://nutdregs19.github.io', changeOrigin: true, rewrite: (p) => '/fafon' + p },
    },
  },
  plugins: [
    localData(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'ฟ้าฝน — พยากรณ์อากาศ',
        short_name: 'ฟ้าฝน',
        description: 'ดูฝน เมฆ ลม อุณหภูมิ ล่วงหน้า 10 วัน',
        lang: 'th',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0f17',
        theme_color: '#0b0f17',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['data/**'],
        importScripts: ['push-sw.js'], // rain alert notifications
        navigateFallbackDenylist: [/\/data\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/data/manifest.json'),
            handler: 'NetworkFirst',
            options: { cacheName: 'manifest', networkTimeoutSeconds: 6 },
          },
          {
            // frame names contain the run time, so a cached file never goes stale
            urlPattern: ({ url }) => /\/data\/(ecmwf|gfs|world)\/.*\.png$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'frames', expiration: { maxEntries: 1500, maxAgeSeconds: 3 * 86400 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'basemap', expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 86400 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'gibs.earthdata.nasa.gov',
            handler: 'CacheFirst',
            options: { cacheName: 'satellite', expiration: { maxEntries: 600, maxAgeSeconds: 86400 } },
          },
          {
            urlPattern: ({ url }) => url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com'),
            handler: 'CacheFirst',
            options: { cacheName: 'fonts', expiration: { maxEntries: 30, maxAgeSeconds: 365 * 86400 } },
          },
        ],
      },
    }),
  ],
});
