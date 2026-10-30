/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import type { PushPayload } from '@initiative/shared';
import { bereichLesen } from './lib/bereich.js';
import {
  MEDIEN_AUFRAEUMEN_ABSTAND_MS,
  ablegbar,
  gedrosselt,
  verdraengen,
  type VorratEintrag,
} from './lib/medienVorrat.js';

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

/**
 * Modelle, die es nicht mehr gibt – und die aus dem Speicher müssen.
 *
 * Der Modellspeicher überlebt jedes Update mit Absicht: Er soll nicht bei
 * jeder Fassung 80 MB über das Mobilfunknetz nachladen. Genau das macht ihn
 * aber zur Falle, wenn ein Modell ersetzt wird. Wer die 1024er Fassung von
 * „Hohe Qualität“ einmal geladen hatte, behielte 114 MB, die nie wieder
 * jemand anfragt – und lüde die neue Datei zusätzlich.
 *
 * Deshalb hier eine ausdrückliche Liste. Sie wächst nur, wenn ein Modell
 * wirklich verschwindet, und sie ist billig: ein Löschversuch je Eintrag beim
 * Aktivieren.
 */
const ABGELEGTE_MODELLE = ['/models/birefnet-lite-1024.onnx'];
const SHELL_FALLBACK = 'index.html';

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

      // Ausgemusterte Modelle wegräumen. Der Speicher selbst bleibt – nur die
      // Einträge, die keiner mehr anfragt, gehen.
      if (ABGELEGTE_MODELLE.length > 0) {
        const modelle = await caches.open(MODEL_CACHE);
        await Promise.all(
          ABGELEGTE_MODELLE.map((pfad) => modelle.delete(pfad, { ignoreVary: true })),
        );
      }

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
  // Auch `/bytes` und `/download`: Ohne die liesse sich eine Datei, die man
  // gerade offline vor Augen hat, weder bearbeiten noch speichern – der
  // Anker am Ende des Musters schloss beide bisher aus.
  return (
    /\/api\/v1\/media\/[0-9a-f-]{36}(\/(bytes|download))?$/.test(url.pathname) ||
    url.pathname.startsWith('/media/')
  );
}

/**
 * Pfade, für die der Workbox-Precache schon selbst antwortet.
 *
 * Nur die Wurzel und die Schale selbst stehen im Manifest; alle anderen Pfade
 * der App (`/chats`, `/kalender`, …) sind Client-Routen und kommen dort nicht
 * vor. Für die beiden hier darf dieser Arbeiter nicht auch noch antworten.
 */
function precacheAntwortet(url: URL): boolean {
  return url.pathname === '/' || url.pathname === '/index.html';
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
    /*
     * `waitUntil` hier, synchron im Ereignis – nicht erst aus `cacheFirst`
     * heraus. Später gerufen wirft Chromium „event handler is already
     * finished", und das risse die Antwort mit: Das Bild bliebe leer.
     */
    const stand: { ablage: Promise<void> | null } = { ablage: null };
    const antwort = cacheFirst(request, MEDIA_CACHE, (abgelegt) => {
      medienZugriffe.set(request.url, Date.now());
      stand.ablage = abgelegt ?? null;
    });
    event.respondWith(antwort);
    event.waitUntil(
      antwort.then(
        () => (stand.ablage ? stand.ablage.then(() => medienAufraeumen()) : undefined),
        () => {},
      ),
    );
    return;
  }

  // Modelle und WASM-Laufzeit: einmal laden, dann fuer immer aus dem Gerät.
  if (isModelRequest(url)) {
    event.respondWith(cacheFirst(request, MODEL_CACHE));
    return;
  }

  /*
   * Die App-Schale für Navigationen, damit die PWA offline aufgeht.
   *
   * Zwei Dinge waren hier falsch, und beide zeigten sich erst ohne Netz.
   *
   * **Der Rückfall traf nie.** `caches.match('/index.html')` sucht genau
   * diese Adresse. Der Workbox-Precache legt die Datei aber unter ihrem
   * Cache-SCHLÜSSEL ab – `index.html?__WB_REVISION__=<hash>`, im gebauten
   * `sw.js` nachzulesen. Der Treffer war damit unmöglich, und übrig blieb
   * `Response.error()`: Offline führte jeder Verweis auf `/chats`,
   * `/kalender` oder `/spiele` – also genau die Verknüpfungen aus dem
   * Manifest – auf eine kaputte Seite. `matchPrecache` schlägt über den
   * Schlüssel nach und trifft.
   *
   * **Zweimal geantwortet.** `precacheAndRoute` hängt seinen eigenen
   * fetch-Behandler an, und zwar VOR diesem. Für `/` greift dort die Regel
   * für das Verzeichnis (`directoryIndex: 'index.html'`), der Precache
   * antwortet – und dieser Behandler rief danach ein zweites Mal
   * `respondWith`, was im Arbeiter einen `InvalidStateError` wirft. Bei
   * jedem Aufruf der Startseite. Deshalb überlassen wir `/` jetzt dem
   * Precache und kümmern uns nur um die Pfade, die er nicht kennt.
   */
  if (request.mode === 'navigate' && !precacheAntwortet(url)) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await matchPrecache(SHELL_FALLBACK);
          return cached ?? Response.error();
        }
      })(),
    );
  }
});

/**
 * Aus einer abgelegten ganzen Antwort einen Ausschnitt schneiden.
 *
 * Die Cache-API vergleicht beim Nachschlagen nur die Adresse und ignoriert den
 * `Range`-Kopf: Eine Teilanfrage bekam deshalb die GANZE Datei mit Status 200.
 * Für `<video>` und `<audio>` ist das die falsche Antwort – WebKit verlangt
 * eine 206 und bricht sonst ab. Ein Video, das vollständig im Gerät lag, blieb
 * schwarz.
 *
 * `null` heisst „nicht erfüllbar oder nicht verstanden" – dann geht die ganze
 * Antwort hinaus, so wie bisher.
 */
async function teilAntwort(gespeichert: Response, kopf: string | null): Promise<Response | null> {
  const daten = await gespeichert.clone().arrayBuffer();
  const bereich = bereichLesen(kopf, daten.byteLength);
  if (!bereich) return null;
  const stueck = daten.slice(bereich.start, bereich.ende + 1);
  const kopfzeilen = new Headers(gespeichert.headers);
  kopfzeilen.set('content-range', `bytes ${bereich.start}-${bereich.ende}/${daten.byteLength}`);
  kopfzeilen.set('content-length', String(stueck.byteLength));
  kopfzeilen.set('accept-ranges', 'bytes');
  return new Response(stueck, {
    status: 206,
    statusText: 'Partial Content',
    headers: kopfzeilen,
  });
}

async function cacheFirst(
  request: Request,
  cacheName: string,
  /**
   * Nur der Medienspeicher führt Buch (Grenze, siehe `medienAufraeumen`).
   * Bei einem Treffer ohne Argument, beim Ablegen mit dem Ablegen selbst.
   * Aufgeräumt wird nur danach – nur dann kann der Speicher wachsen, und
   * `waitUntil` im Abruf hält den Arbeiter bis zum gedrosselten Lauf wach.
   */
  gebraucht?: (abgelegt?: Promise<void>) => void,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const bereichKopf = request.headers.get('range');
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    gebraucht?.();
    if (!bereichKopf) return cached;
    // Eine abgelegte 206 gibt es nicht (unten wird nur bei 200 abgelegt), also
    // ist das Geschnittene immer aus der vollen Datei.
    const teil = await teilAntwort(cached, bereichKopf);
    return teil ?? cached;
  }
  try {
    const response = await fetch(request);
    // Nur der Medienspeicher kennt die Einzelgrenze; Modelle (bis 94 MB)
    // sollen weiter abgelegt werden.
    const zuGross = gebraucht !== undefined && !ablegbar(response.headers.get('content-length'));
    if (response.ok && response.status === 200 && !zuGross) {
      // Fehlschlagen darf das: Das groesste Modell ist knapp 94 MB, und auf
      // einem iPhone mit knappem Speicherkontingent lehnt der Browser die
      // Ablage ab. Dann wird eben beim naechsten Mal wieder geladen – das ist
      // besser, als das Freistellen an einer vollen Ablage scheitern zu lassen.
      // Erst ablegen, dann melden – getrennt, weil `gebraucht?.(…)` sein
      // Argument gar nicht auswertet, wenn niemand Buch führt (Modelle).
      const abgelegt = cache.put(request, response.clone()).catch(() => {});
      gebraucht?.(abgelegt);
    }
    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreVary: true });
    if (fallback) {
      if (!bereichKopf) return fallback;
      const teil = await teilAntwort(fallback, bereichKopf);
      return teil ?? fallback;
    }
    throw error;
  }
}

/*
 * ---------- Grenze des Medienspeichers ----------
 *
 * Was ausgewählt wird, steht in `lib/medienVorrat.ts`; hier nur die
 * Buchführung. Die Cache-API kennt weder Grösse noch letzten Zugriff eines
 * Eintrags. Beides steht deshalb in einem kleinen Verzeichnis IM selben
 * Speicher (`MEDIEN_VERZEICHNIS`) – so verschwindet es mit ihm, und es gibt
 * keinen zweiten Ort, der aus dem Takt geraten kann.
 *
 * Zugriffe landen erst im Arbeitsspeicher (`medienZugriffe`) und werden beim
 * nächsten Aufräumen eingetragen. Geht der Arbeiter vorher schlafen, fehlen
 * ein paar Zeitstempel – dann ist die Reihenfolge eben etwas ungenauer. Das
 * ist billiger als ein Schreibvorgang bei jedem angezeigten Bild.
 */
const MEDIEN_VERZEICHNIS = new URL('/__medienvorrat.json', self.location.origin).href;

type MedienVerzeichnis = Record<string, { bytes: number; zuletzt: number }>;

const medienZugriffe = new Map<string, number>();

const medienAufraeumen = gedrosselt(async () => {
  const cache = await caches.open(MEDIA_CACHE);
  const gelesen = await cache.match(MEDIEN_VERZEICHNIS);
  const verzeichnis: MedienVerzeichnis = gelesen
    ? ((await gelesen.json().catch(() => ({}))) as MedienVerzeichnis)
    : {};
  const zugriffe = new Map(medienZugriffe);
  medienZugriffe.clear();

  const eintraege: VorratEintrag[] = [];
  const neu: MedienVerzeichnis = {};
  for (const anfrage of await cache.keys()) {
    const url = anfrage.url;
    if (url === MEDIEN_VERZEICHNIS) continue;
    let bekannt = verzeichnis[url];
    if (!bekannt) {
      // Altbestand von vor dieser Grenze, oder ein Eintrag, dessen Buchung
      // verloren ging: Grösse einmal nachmessen, Zeit unbekannt (0) – damit
      // geht er als einer der ersten.
      const antwort = await cache.match(anfrage, { ignoreVary: true });
      const laenge = Number(antwort?.headers.get('content-length'));
      const bytes =
        Number.isFinite(laenge) && laenge > 0 ? laenge : ((await antwort?.blob())?.size ?? 0);
      bekannt = { bytes, zuletzt: 0 };
    }
    const zuletzt = Math.max(bekannt.zuletzt, zugriffe.get(url) ?? 0);
    neu[url] = { bytes: bekannt.bytes, zuletzt };
    eintraege.push({ url, bytes: bekannt.bytes, zuletzt });
  }

  for (const url of verdraengen(eintraege)) {
    await cache.delete(url, { ignoreVary: true });
    delete neu[url];
  }
  await cache.put(
    MEDIEN_VERZEICHNIS,
    new Response(JSON.stringify(neu), { headers: { 'content-type': 'application/json' } }),
  );
}, MEDIEN_AUFRAEUMEN_ABSTAND_MS);

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

/*
 * Die Symboladressen – mit einem Rückfall für den Entwicklungsbetrieb.
 *
 * `define` aus `vite.config.ts` ersetzt diese Kennungen nur im BAU:
 * Vites `vite:define` bricht für den Client ab, solange nicht gebaut wird,
 * und der Service Worker bekommt auch keine Umgebung eingespritzt.
 * Nachgemessen liefert `dev-sw.js` deshalb wörtlich `__SYMBOL_ICON__`, und
 * jede Benachrichtigung endete dort in einem `ReferenceError` – also in gar
 * keiner Benachrichtigung.
 *
 * `typeof` auf eine unbekannte Kennung ist die einzige Abfrage, die nicht
 * selbst wirft. Im Entwicklungsbetrieb steht dann der schlichte Name da; die
 * Datei gibt es dort zwar nicht, aber eine Benachrichtigung ohne Bild ist
 * unendlich viel besser als keine.
 */
const SYMBOL_ICON = typeof __SYMBOL_ICON__ === 'string' ? __SYMBOL_ICON__ : '/icons/icon-192.png';
const SYMBOL_BADGE =
  typeof __SYMBOL_BADGE__ === 'string' ? __SYMBOL_BADGE__ : '/icons/badge-96.png';

/** Liest die Nutzlast – auch eine leere oder kaputte ergibt eine Mitteilung. */
function nutzlastLesen(data: PushMessageData | null): PushPayload {
  const rueckfall: PushPayload = {
    title: 'Initiative',
    body: 'Neue Nachricht',
    url: '/',
    kind: 'system',
  };
  if (!data) return rueckfall;
  try {
    return { ...rueckfall, ...(data.json() as PushPayload) };
  } catch {
    const text = data.text();
    return text ? { ...rueckfall, body: text } : rueckfall;
  }
}

async function fensterHolen(): Promise<readonly WindowClient[]> {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

/*
 * Jedes push-Ereignis zeigt eine Mitteilung.
 *
 * Safari (iOS) verlangt das ausnahmslos: Ein push ohne sichtbare Mitteilung
 * zählt als Verstoss gegen `userVisibleOnly`, und nach wenigen solchen
 * entzieht Safari das Abo – danach kommt auf dem iPhone nie wieder etwas an,
 * ohne dass es jemand merkt. Hier gab es zwei solche Wege: ein push ohne
 * Daten (`return`) und der offene, sichtbare Chat (nur `postMessage`). Beim
 * offenen Chat wird jetzt trotzdem gezeigt – leise, und gleich wieder
 * geschlossen, wo der Browser das zulässt.
 *
 * Und jedes push sagt den offenen Fenstern Bescheid. Auf dem iPhone friert die
 * App im Hintergrund ein, die Echtzeitleitung stirbt ohne `close`, und die
 * Chatliste zeigte nach der Rückkehr nicht, dass jemand geantwortet hat. Die
 * Botschaft wartet, bis das Fenster wieder läuft, und löst dort das Nachholen
 * aus (`state/chat.ts`).
 */
self.addEventListener('push', (event) => {
  const payload = nutzlastLesen(event.data);

  event.waitUntil(
    (async () => {
      const fenster = await fensterHolen();
      for (const client of fenster) client.postMessage({ type: 'push', payload });

      const imChat = fenster.some(
        (client) =>
          // Nur „sichtbar“, nicht „fokussiert“: Der Server schickt für einen
          // sichtbaren Chat ohnehin nichts mehr (`chat.sichtbar`); das hier ist
          // der Rückfall für einen Push, der der Meldung zuvorkam. Auf dem
          // iPhone ist `focused` in der installierten App nicht verlässlich.
          client.visibilityState === 'visible' &&
          Boolean(payload.conversationId) &&
          client.url.includes(payload.conversationId as string),
      );
      const tag = payload.tag ?? payload.kind;

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon ?? SYMBOL_ICON,
        badge: payload.badge ?? SYMBOL_BADGE,
        tag,
        renotify: Boolean(payload.tag) && !imChat,
        silent: imChat,
        data: { url: payload.url ?? '/' },
      } as NotificationOptions);

      // Wer den Chat vor Augen hat, braucht die Meldung nicht: gezeigt (für
      // Safari), aber sofort wieder weg.
      if (imChat) {
        const gezeigt = await self.registration.getNotifications({ tag });
        for (const mitteilung of gezeigt) mitteilung.close();
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const fenster = await fensterHolen();
      // Lieber ein Fenster dieser App als irgendeines – und das sichtbare zuerst.
      const passend = fenster.find((client) => client.visibilityState === 'visible') ?? fenster[0];
      if (passend) {
        try {
          const vorn = await passend.focus();
          vorn.postMessage({ type: 'navigate', url: target });
          return;
        } catch {
          // `focus` ist ohne Nutzergeste verboten oder das Fenster ist weg –
          // dann ein neues öffnen.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/*
 * Der Browser hat das Abo ausgetauscht (abgelaufen, vom Dienst erneuert).
 *
 * Ohne Behandlung gingen alle Mitteilungen an die alte, tote Adresse, bis
 * jemand den Schalter in den Einstellungen von Hand neu umlegt. Hier wird mit
 * denselben Optionen neu abonniert; ANMELDEN kann der Service Worker das neue
 * Abo nicht (er hat kein Zugriffstoken) – das übernimmt die App, sobald sie
 * läuft (`aboAuffrischen` in `lib/push.ts`, beim Start und auf diese
 * Botschaft hin).
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  const aenderung = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
    waitUntil(promise: Promise<unknown>): void;
  };
  aenderung.waitUntil(
    (async () => {
      if (!aenderung.newSubscription) {
        const schluessel = aenderung.oldSubscription?.options?.applicationServerKey;
        if (schluessel) {
          await self.registration.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey: schluessel })
            .catch(() => null);
        }
      }
      for (const client of await fensterHolen()) {
        client.postMessage({ type: 'push-abo-geaendert' });
      }
    })(),
  );
});
