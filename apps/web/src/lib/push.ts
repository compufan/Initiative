import { ApiError, api } from './api.js';

/**
 * Web Push registration.
 *
 * Android/Chrome/Firefox can subscribe from the browser; on iOS the PWA has to
 * be installed to the home screen first (iOS 16.4+), which the UI explains.
 */

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iOS only exposes the Push API inside an installed (standalone) PWA. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type PushStatus = 'unsupported' | 'needs-install' | 'denied' | 'granted' | 'default';

export function pushStatus(): PushStatus {
  /*
   * iOS zuerst: Ausserhalb der installierten App gibt es dort kein Push, ganz
   * gleich, welche Teile der Schnittstelle Safari im Tab schon zeigt. Vorher
   * wurde das nur geprüft, wenn `pushSupported()` falsch war – zeigte ein
   * neueres Safari im Tab `Notification` und `PushManager`, landete man im
   * Erlaubnis-Dialog, der dort nie „granted“ liefert.
   */
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return 'default';
}

/** Warum das Einschalten nicht geklappt hat – je Ursache eine Meldung. */
export type PushGrund =
  | 'nicht-unterstuetzt'
  | 'ios-installieren'
  | 'blockiert'
  | 'nicht-erlaubt'
  | 'server-ohne-schluessel'
  | 'server-nicht-erreichbar'
  | 'kein-service-worker'
  | 'abo-fehlgeschlagen'
  | 'server-lehnt-ab';

export type PushErgebnis = { ok: true } | { ok: false; grund: PushGrund; detail?: string };

/** Die Meldung an die Person – ehrlich, je Ursache, ohne zu raten. */
export function pushMeldung(ergebnis: Extract<PushErgebnis, { ok: false }>): string {
  const detail = ergebnis.detail ? ` (${ergebnis.detail})` : '';
  switch (ergebnis.grund) {
    case 'nicht-unterstuetzt':
      return 'Dieser Browser kann keine Benachrichtigungen empfangen';
    case 'ios-installieren':
      return 'Auf dem iPhone gehen Benachrichtigungen nur in der installierten App (Zum Home-Bildschirm)';
    case 'blockiert':
      return 'Benachrichtigungen sind für Initiative blockiert – in den Einstellungen des Geräts erlauben';
    case 'nicht-erlaubt':
      return 'Benachrichtigungen wurden nicht erlaubt';
    case 'server-ohne-schluessel':
      return 'Dieser Server verschickt gerade keine Benachrichtigungen';
    case 'server-nicht-erreichbar':
      return `Server nicht erreichbar – bitte gleich noch einmal versuchen${detail}`;
    case 'kein-service-worker':
      return 'Die App ist noch nicht fertig eingerichtet – Seite neu laden und noch einmal versuchen';
    case 'abo-fehlgeschlagen':
      return `Das Gerät konnte kein Push-Abo anlegen${detail}`;
    case 'server-lehnt-ab':
      return `Der Server hat das Push-Abo abgelehnt${detail}`;
  }
}

/**
 * Fragt nach der Erlaubnis – in beiden Formen, die Browser kennen.
 *
 * Älteres Safari kennt nur den Rückruf und gibt kein Versprechen zurück.
 */
function erlaubnisAnfragen(): Promise<NotificationPermission> {
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return new Promise((fertig) => {
    const ergebnis = Notification.requestPermission(fertig);
    if (ergebnis && typeof ergebnis.then === 'function') {
      ergebnis.then(fertig, () => fertig(Notification.permission));
    }
  });
}

/** Wie lange höchstens auf den Service Worker gewartet wird. */
const SW_FRIST_MS = 10_000;

/**
 * Push auf diesem Gerät einschalten.
 *
 * **Die Reihenfolge ist der Kern.** Hier stand zuerst `await
 * api.push.publicKey()` und DANACH `Notification.requestPermission()`. Safari
 * (iOS, auch installiert) erlaubt die Abfrage aber nur unmittelbar aus einer
 * Geste der Person; nach dem Netzweg war die Geste verbraucht, und Safari
 * antwortete ohne Dialog mit „denied“ oder „default“ – auf dem Gerät hiess es
 * dann „Benachrichtigungen wurden nicht erlaubt“, obwohl niemand gefragt
 * wurde. Jetzt wird die Erlaubnis SYNCHRON im ersten Schritt angefragt, der
 * Schlüssel gleichzeitig geholt.
 *
 * Statt `true/false` gibt es einen Grund zurück: Vorher riet die Oberfläche
 * aus `pushStatus()`, und jeder Fehler nach erteilter Erlaubnis hiess
 * „Dieser Server verschickt gerade keine Benachrichtigungen“.
 */
export function enablePush(): Promise<PushErgebnis> {
  if (isIos() && !isStandalone()) {
    return Promise.resolve({ ok: false, grund: 'ios-installieren' });
  }
  if (!pushSupported()) return Promise.resolve({ ok: false, grund: 'nicht-unterstuetzt' });
  if (Notification.permission === 'denied') {
    return Promise.resolve({ ok: false, grund: 'blockiert' });
  }

  // Beides sofort, im selben Takt wie der Klick – siehe oben.
  const erlaubnis = erlaubnisAnfragen();
  const schluessel = api.push.publicKey().then(
    (antwort) => antwort,
    (error: unknown) => error,
  );
  return pushFortsetzen(erlaubnis, schluessel);
}

async function pushFortsetzen(
  erlaubnis: Promise<NotificationPermission>,
  schluessel: Promise<unknown>,
): Promise<PushErgebnis> {
  const permission = await erlaubnis;
  if (permission === 'denied') return { ok: false, grund: 'blockiert' };
  if (permission !== 'granted') return { ok: false, grund: 'nicht-erlaubt' };

  const antwort = await schluessel;
  if (antwort instanceof Error || !antwort || typeof antwort !== 'object') {
    return {
      ok: false,
      grund: 'server-nicht-erreichbar',
      detail: antwort instanceof Error ? antwort.message : undefined,
    };
  }
  const { publicKey, enabled } = antwort as { publicKey: string | null; enabled: boolean };
  if (!enabled || !publicKey) return { ok: false, grund: 'server-ohne-schluessel' };

  // `ready` wartet ewig, wenn kein Service Worker registriert ist (etwa im
  // Entwicklungsbetrieb oder nach einem fehlgeschlagenen Update). Ohne Frist
  // drehte sich der Schalter dann endlos.
  let frist: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((fertig) => {
      frist = setTimeout(() => fertig(null), SW_FRIST_MS);
    }),
  ]);
  clearTimeout(frist);
  if (!registration) return { ok: false, grund: 'kein-service-worker' };
  return aboMelden(registration.pushManager, publicKey);
}

/** Ist dieses Browser-Abo an genau diesen Server-Schlüssel gebunden? */
function gleicherSchluessel(subscription: PushSubscription, erwartet: Uint8Array): boolean {
  const vorhanden = subscription.options?.applicationServerKey;
  // Ohne Angabe (manche Browser liefern `null`) lässt sich nichts vergleichen –
  // dann gilt das Abo als passend, wie bisher.
  if (!vorhanden) return true;
  const bytes = new Uint8Array(vorhanden);
  return bytes.length === erwartet.length && bytes.every((byte, index) => byte === erwartet[index]);
}

function fehlerText(error: unknown): string {
  if (error instanceof Error)
    return error.name && error.name !== 'Error' ? error.name : error.message;
  return String(error);
}

/**
 * Das Abo dieses Browsers anlegen (oder das passende wiederverwenden) und
 * beim Server anmelden.
 *
 * - Gehört das vorhandene Abo zu einem ANDEREN Server-Schlüssel (der Schlüssel
 *   wurde getauscht, oder der Server hat sich selbst eines erzeugt), nimmt der
 *   Push-Dienst nichts mehr an, was mit dem neuen signiert ist. Es wird gelöst
 *   und neu angelegt – sonst wäre das Gerät angemeldet und trotzdem stumm.
 * - Antwortet der Server mit 409, gehört die Adresse schon einem anderen
 *   Konto (etwa weil sich auf diesem Gerät jemand angemeldet hat, ohne dass
 *   das vorige Konto sauber abgemeldet wurde). Der Server hängt ein fremdes
 *   Abo nicht um (sonst ließe es sich kapern). Also wird das Browser-Abo
 *   gelöst und ein neues mit neuer Adresse angelegt – einmal, nicht in einer
 *   Schleife.
 */
export async function aboMelden(
  pushManager: PushManager,
  publicKey: string,
  zweiterVersuch = false,
): Promise<PushErgebnis> {
  const schluessel = urlBase64ToBytes(publicKey);
  let subscription: PushSubscription;
  try {
    let vorhanden = await pushManager.getSubscription();
    if (vorhanden && !gleicherSchluessel(vorhanden, schluessel)) {
      await vorhanden.unsubscribe().catch(() => false);
      vorhanden = null;
    }
    subscription =
      vorhanden ??
      (await pushManager.subscribe({
        // Pflicht für Chrome und Safari: Jede Mitteilung wird angezeigt.
        userVisibleOnly: true,
        applicationServerKey: schluessel,
      }));
  } catch (error) {
    return { ok: false, grund: 'abo-fehlgeschlagen', detail: fehlerText(error) };
  }

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return { ok: false, grund: 'abo-fehlgeschlagen', detail: 'Abo ohne Schlüssel' };
  }

  try {
    await api.push.subscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
  } catch (error) {
    if (!zweiterVersuch && error instanceof ApiError && error.status === 409) {
      await subscription.unsubscribe().catch(() => false);
      return aboMelden(pushManager, publicKey, true);
    }
    if (error instanceof ApiError && error.isOffline) {
      return { ok: false, grund: 'server-nicht-erreichbar' };
    }
    return {
      ok: false,
      grund: 'server-lehnt-ab',
      detail: error instanceof Error ? error.message : undefined,
    };
  }
  return { ok: true };
}

/**
 * Hat dieses Gerät ein Push-Abo? `false` auch, wenn es keinen Service Worker
 * gibt oder er nicht rechtzeitig bereit ist.
 */
export async function aboVorhanden(): Promise<boolean> {
  if (!pushSupported() || (isIos() && !isStandalone())) return false;
  let frist: ReturnType<typeof setTimeout> | undefined;
  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((fertig) => {
        frist = setTimeout(() => fertig(null), SW_FRIST_MS);
      }),
    ]);
    return Boolean(registration && (await registration.pushManager.getSubscription()));
  } catch {
    return false;
  } finally {
    clearTimeout(frist);
  }
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.push.unsubscribe(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/**
 * Meldet ein vorhandenes Abo still erneut an – beim Start der App und wenn der
 * Service Worker meldet, dass der Browser das Abo ausgetauscht hat
 * (`pushsubscriptionchange`).
 *
 * WARUM: Der Service Worker kann das neue Abo selbst nicht anmelden – er hat
 * kein Zugriffstoken. Und ohne Anmeldung ginge jede Mitteilung an die alte,
 * tote Adresse. Nur wenn die Erlaubnis steht; gefragt wird hier nie.
 */
export async function aboAuffrischen(): Promise<PushErgebnis | null> {
  if (pushStatus() !== 'granted') return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    // Wer Push hier ausgeschaltet hat, hat kein Abo – dann bleibt es so.
    if (!(await registration.pushManager.getSubscription())) return null;
    const { publicKey, enabled } = await api.push.publicKey();
    if (!enabled || !publicKey) return null;
    return await aboMelden(registration.pushManager, publicKey);
  } catch {
    return null;
  }
}
