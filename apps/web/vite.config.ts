import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Die Adressen der App-Symbole – mit Inhaltskennung im Namen.
 *
 * # Warum die Kennung nötig ist
 *
 * Der Anwender meldete zweimal: „Das Logo ist immer noch nicht das App
 * Icon." Gebaut wurden die Symbole korrekt, nachgemessen liegen sie im
 * `dist` und stehen im Manifest. Der Fehler liegt hinter der Auslieferung:
 * Die Adressen waren FEST, ein neues Logo ergab also neue Bytes unter
 * derselben Adresse. Caddy gab `/icons/*` sieben Tage lang aus dem Cache,
 * Chrome prüft ein Manifest höchstens einmal in 24 Stunden und holt die
 * WebAPK nur, wenn sich darin etwas geändert hat – und da stand überall
 * dasselbe. iOS erneuert das Symbol einer abgelegten Web-App ohnehin nie.
 *
 * Mit einer Kennung im Dateinamen ist die Änderung im Manifest unübersehbar,
 * und der Cache kann die alten Bytes gar nicht mehr vorhalten: Ihre Adresse
 * gibt es nicht mehr.
 *
 * # Warum es hier einen Rückfall gibt und keinen Abbruch
 *
 * Weil `pnpm build` erst `prebuild` laufen lässt und die Karte dann da ist –
 * wer aber `vite build` oder `vite` direkt aufruft, und das tut früher oder
 * später jeder, bekäme statt einer App eine Fehlermeldung. Ohne Karte gelten
 * die schlichten Namen; dass die Kennung fehlt, steht dann in der Ausgabe.
 */
const SYMBOL_ROLLEN = [
  'icon-192.png',
  'icon-512.png',
  'maskable-192.png',
  'maskable-512.png',
  'apple-touch-icon.png',
  'favicon-32.png',
  'favicon-64.png',
  'badge-96.png',
] as const;

type SymbolRolle = (typeof SYMBOL_ROLLEN)[number];

function symbolAdressen(): Record<SymbolRolle, string> {
  const schlicht = Object.fromEntries(
    SYMBOL_ROLLEN.map((rolle) => [rolle, `/icons/${rolle}`]),
  ) as Record<SymbolRolle, string>;
  const karte = fileURLToPath(new URL('./.marke/symbole.json', import.meta.url));
  if (!existsSync(karte)) {
    console.warn(
      '[marke] .marke/symbole.json fehlt – die Symbole laufen ohne Inhaltskennung. ' +
        'Einmal `pnpm --filter @initiative/web marke` aufrufen.',
    );
    return schlicht;
  }
  const gelesen = JSON.parse(readFileSync(karte, 'utf8')) as Record<string, string>;
  return Object.fromEntries(
    SYMBOL_ROLLEN.map((rolle) => [rolle, gelesen[rolle] ?? schlicht[rolle]]),
  ) as Record<SymbolRolle, string>;
}

/**
 * Schreibt die Symboladressen in `index.html` und prüft sie am Ende.
 *
 * Der zweite Teil ist der wichtigere: Ein Manifest, das auf Adressen zeigt,
 * die es nicht gibt, ist schlimmer als ein altes Symbol – dann hat der
 * Anwender gar keines. Geprüft wird deshalb am fertigen Bündel und nicht in
 * einem Test: `vitest` läuft ohne Bau und schliesst `dist` ausdrücklich aus.
 */
function markeAdressen(adressen: Record<SymbolRolle, string>): Plugin {
  return {
    name: 'initiative-marke-adressen',
    transformIndexHtml(html) {
      let raus = html;
      for (const rolle of SYMBOL_ROLLEN) {
        raus = raus.split(`/icons/${rolle}`).join(adressen[rolle]);
      }
      return raus;
    },
    closeBundle() {
      const dist = fileURLToPath(new URL('./dist', import.meta.url));
      const fehlend = SYMBOL_ROLLEN.filter((rolle) => !existsSync(`${dist}${adressen[rolle]}`)).map(
        (rolle) => adressen[rolle],
      );
      if (fehlend.length > 0) {
        throw new Error(
          `[marke] Diese Symboladressen stehen im Manifest, liegen aber nicht in dist: ${fehlend.join(', ')}`,
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_DEV_API_PROXY ?? 'http://localhost:8080';

  // Welcher Stand ist das hier? Vercel und GitHub legen den Commit als
  // Umgebungsvariable bereit; lokal steht schlicht "dev".
  const commit = (env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || 'dev').slice(0, 7);
  const symbole = symbolAdressen();

  return {
    define: {
      __APP_COMMIT__: JSON.stringify(commit),
      /*
       * Der Service Worker zeigt diese beiden an jeder Benachrichtigung.
       * Fest eingetragen wären es nach dem Umbau zwei Adressen, die es nicht
       * mehr gibt – und eine Benachrichtigung ohne Bild.
       */
      __SYMBOL_ICON__: JSON.stringify(symbole['icon-192.png']),
      __SYMBOL_BADGE__: JSON.stringify(symbole['badge-96.png']),
    },
    /*
     * Arbeiter als ES-Module bauen.
     *
     * Vite baut sie voreingestellt als `iife`, und das verträgt sich nicht mit
     * `import()` – Rollup lehnt es ausdrücklich ab („UMD and IIFE output
     * formats are not supported for code-splitting builds"). Der
     * BiRefNet-Arbeiter lädt ONNX Runtime aber genau so, damit die 26 MB
     * Laufzeit erst beim ersten Freistellen geholt werden und nicht bei jedem
     * Start der App.
     *
     * Passt zu `new Worker(..., { type: 'module' })` an der Aufrufstelle.
     * Beides muss gemeinsam stimmen: Ein Modul-Arbeiter, der als iife gebaut
     * wird, lädt nicht – und ein klassischer Arbeiter aus ES-Modulcode auch
     * nicht.
     */
    worker: {
      format: 'es' as const,
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
        /*
         * Zwei Einstiegspunkte: die App und das Blatt für den Fernseher.
         *
         * `tv.html` ist bewusst KEINE Seite der App. In einem Fernseher steckt
         * selten ein aktueller Browser, und die App zieht React, den Wegweiser
         * und die Freistell-Bausteine mit sich. Das Blatt daneben lädt ein
         * paar Kilobyte und braucht keine einzige fremde Bibliothek.
         *
         * Dazu kommt, dass es OHNE Anmeldung laufen muss – ein Fernseher hat
         * kein Konto. In der App liegt alles hinter dem Anmeldeschirm, und das
         * soll so bleiben.
         */
        input: {
          index: fileURLToPath(new URL('./index.html', import.meta.url)),
          tv: fileURLToPath(new URL('./tv.html', import.meta.url)),
        },
        /*
         * Die Adresse ist `/tv`, die Datei heisst `tv.html`.
         *
         * Der Entwicklungsserver löst das von SELBST auf – nachgemessen: Ein
         * Einstiegspunkt namens `tv.html` beantwortet auch `/tv`. Ein eigenes
         * Zwischenstück dafür stand hier und war tote Arbeit.
         *
         * In der Auslieferung tut das niemand von selbst. Dort schreiben
         * `Caddyfile` und `vercel.json` `/tv` auf `tv.html` um, und weil der
         * Entwicklungsserver den Fehler nicht zeigen kann, hält
         * `e2e/fernsehen.spec.ts` beide Stellen ausdrücklich fest.
         */
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
      markeAdressen(symbole),
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
          // Die Freistell-Bausteine sind zusammen ueber 120 MB. Sie duerfen
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
            /*
             * Das Logo liegt nicht mehr im Vorrat der installierten App.
             *
             * Ihr Hintergrund zeigt seit der Umrechnung `hintergrund.png` –
             * in beiden Themen, siehe `global.css`. `logo.png` braucht nur
             * noch `tv.html`, und das Fernsehblatt läuft ohnehin nie ohne
             * Netz: Es wird auf einem Fernseher geöffnet, der gerade eine
             * Verbindung zu dieser App hat. Beide Dateien vorzuhalten hiesse,
             * jeder Installation gut hundert Kilobyte aufzuladen, die sie nie
             * anfordert.
             */
            'marke/logo.png',
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
          /*
           * `id: '/'` bleibt, die Symboladressen wechseln.
           *
           * Das ist der ganze Trick: Eine geänderte `id` ergäbe eine ZWEITE
           * installierte App statt einer aktualisierten. Geänderte
           * Symboladressen sind dagegen genau die Änderung, auf die Chrome
           * beim Erneuern der WebAPK wartet.
           */
          icons: [
            {
              src: symbole['icon-192.png'],
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: symbole['icon-512.png'],
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: symbole['maskable-192.png'],
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: symbole['maskable-512.png'],
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
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
