/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import type { PushPayload } from '@initiative/shared';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

const MEDIA_CACHE = 'initiative-media-v1';
/**
 * Die Freistell-Modelle und ihre WASM-Laufzeit. Eigener Speicher, weil sie
 * anders altern als Bilder: Sie werden einmal geladen und dann jahrelang
 * unveraendert benutzt. Beim Aufraeumen bleibt dieser Speicher erhalten,
 * damit ein Update nicht 22 MB erneut ueber das Mobilfunknetz zieht.
 */
const MODEL_CACHE = 'initiative-models-v1';
const KEEP_CACHES = [MEDIA_CACHE, MODEL_CACHE];
const SHELL_FALLBACK = '/index.html';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => {
  // The app prompts before applying an update, so do not skip waiting here.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('initiative-') && !KEEP_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

function isMediaRequest(url: URL): boolean {
  return (
    /\/api\/v1\/media\/[0-9a-f-]{36}$/.test(url.pathname) || url.pathname.startsWith('/media/')
  );
}

/** Die Freistell-Bausteine: unter /mediapipe/ und /models/. */
function isModelRequest(url: URL): boolean {
  return url.pathname.startsWith('/mediapipe/') || url.pathname.startsWith('/models/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Web Share Target: files shared from the OS land here as a POST.
  if (request.method === 'POST' && url.pathname === '/teilen') {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (request.method !== 'GET') return;

  // Media is immutable once uploaded – cache first, then network.
  if (isMediaRequest(url)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE));
    return;
  }

  // Modelle und WASM-Laufzeit: einmal laden, dann fuer immer aus dem Gerät.
  if (isModelRequest(url)) {
    event.respondWith(cacheFirst(request, MODEL_CACHE));
    return;
  }

  // App shell for navigations so the PWA opens offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match(SHELL_FALLBACK);
          return cached ?? Response.error();
        }
      })(),
    );
  }
});

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) {
      // Fehlschlagen darf das: Das groesste Modell ist knapp 94 MB, und auf
      // einem iPhone mit knappem Speicherkontingent lehnt der Browser die
      // Ablage ab. Dann wird eben beim naechsten Mal wieder geladen – das ist
      // besser, als das Freistellen an einer vollen Ablage scheitern zu lassen.
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreVary: true });
    if (fallback) return fallback;
    throw error;
  }
}

const shareCache = new Map<string, { title: string; text: string; url: string; files: File[] }>();

async function handleShareTarget(event: FetchEvent): Promise<Response> {
  try {
    const form = await event.request.formData();
    const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);
    const id = Math.random().toString(36).slice(2);
    shareCache.set(id, {
      title: String(form.get('title') ?? ''),
      text: String(form.get('text') ?? ''),
      url: String(form.get('url') ?? ''),
      files,
    });
    return Response.redirect(`/teilen?share=${id}`, 303);
  } catch {
    return Response.redirect('/', 303);
  }
}

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; id?: string } | undefined;
  if (data?.type === 'GET_SHARE' && data.id) {
    const payload = shareCache.get(data.id);
    shareCache.delete(data.id);
    event.ports[0]?.postMessage(payload ?? null);
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = {
      title: 'Initiative',
      body: event.data.text(),
      url: '/',
      kind: 'system',
    };
  }

  event.waitUntil(
    (async () => {
      // Stay quiet when the matching chat is already open and focused.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = clients.find(
        (client) => client.focused && client.visibilityState === 'visible',
      );
      if (focused && payload.conversationId && focused.url.includes(payload.conversationId)) {
        focused.postMessage({ type: 'push', payload });
        return;
      }

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon ?? '/icons/icon-192.png',
        badge: payload.badge ?? '/icons/badge-96.png',
        tag: payload.tag ?? payload.kind,
        renotify: Boolean(payload.tag),
        data: { url: payload.url ?? '/' },
      } as NotificationOptions);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'navigate', url: target });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
