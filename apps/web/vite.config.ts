import { defaultClientConditions, defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_DEV_API_PROXY ?? 'http://localhost:8080';

  // Welcher Stand ist das hier? Vercel und GitHub legen den Commit als
  // Umgebungsvariable bereit; lokal steht schlicht "dev".
  const commit = (
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    'dev'
  ).slice(0, 7);

  return {
    define: {
      __APP_COMMIT__: JSON.stringify(commit),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      // ONNX Runtime liefert zwei Fassungen aus. Ohne diese Bedingung nimmt
      // Vite die "bundle"-Fassung, die ihre 14-MB-WASM-Datei per
      // `new URL(...)` selbst mitzieht – dann liegt sie doppelt im Build,
      // einmal in assets/ und einmal in public/onnx/. Mit der Bedingung
      // greift die schlanke Fassung, und wir bestimmen den Pfad selbst.
      conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'],
    },
    server: {
      port: 5173,
      // Lets a phone on the same network open the dev build over http://<lan-ip>:5173
      host: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/ws': { target: apiTarget, ws: true, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            // Alles rund ums Freistellen in eigene Stuecke. Der Name ist
            // nicht nur Kosmetik: `chunkFileNames` legt sie darueber in
            // einen eigenen Ordner, den der Service Worker auslaesst.
            'cutout-mediapipe': ['@mediapipe/tasks-vision'],
            'cutout-onnx': ['onnxruntime-web/wasm'],
          },
          chunkFileNames: (chunk) => {
            const freistellen =
              chunk.name.startsWith('cutout') ||
              chunk.facadeModuleId?.includes('/stickers/engines/');
            return freistellen ? 'assets/cutout/[name]-[hash].js' : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    plugins: [
      react(),
      VitePWA({
        // A custom service worker so we can handle Web Push and notification
        // clicks ourselves; Workbox still injects the precache manifest.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: null,
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
          // Die Freistell-Bausteine sind zusammen ueber 22 MB. Sie duerfen
          // NICHT beim Installieren mitgeladen werden – sonst zahlt jeder
          // den Preis, auch wer nie einen Sticker baut. Der Service Worker
          // legt sie stattdessen beim ersten Benutzen dauerhaft ab.
          // Achtung: `globIgnores` ersetzt die Voreinstellung, deshalb steht
          // node_modules hier wieder mit drin.
          globIgnores: [
            '**/node_modules/**/*',
            'mediapipe/**/*',
            'models/**/*',
            // Der Klebe-Code der Modelle – zusammen ueber 200 KB, die nur
            // braucht, wer wirklich einen Sticker freistellt.
            'assets/cutout/**/*',
          ],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        devOptions: {
          enabled: true,
          type: 'module',
          navigateFallback: 'index.html',
        },
        manifest: {
          id: '/',
          name: 'Initiative',
          short_name: 'Initiative',
          description: 'Messenger, Kalender, Umfragen und Mini-Spiele – als PWA auf jedem Gerät.',
          lang: 'de',
          dir: 'ltr',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
          orientation: 'portrait',
          background_color: '#0b1020',
          theme_color: '#0b1020',
          categories: ['social', 'productivity'],
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          shortcuts: [
            { name: 'Neuer Chat', url: '/chats?new=1' },
            { name: 'Kalender', url: '/kalender' },
            { name: 'Spiele', url: '/spiele' },
          ],
          share_target: {
            action: '/teilen',
            method: 'POST',
            enctype: 'multipart/form-data',
            params: {
              title: 'title',
              text: 'text',
              url: 'url',
              files: [{ name: 'files', accept: ['image/*', 'video/*', 'audio/*'] }],
            },
          },
        },
      }),
    ],
  };
});
