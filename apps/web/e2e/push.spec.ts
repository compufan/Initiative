import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Benachrichtigungen und Rückkehr aus dem Hintergrund – gegen einen Server
 * OHNE VAPID-Schlüssel in der Umgebung.
 *
 * Gemeldet von echten Geräten:
 * 1. Nach erteilter Erlaubnis hiess es „Benachrichtigungen wurden nicht
 *    erlaubt“ oder „Dieser Server verschickt gerade keine Benachrichtigungen“.
 *    Ein Server ohne Schlüssel hatte Push schlicht aus; jetzt legt er sich
 *    beim ersten Start selbst ein Paar an.
 * 2. Auf dem iPhone zeigte die Chatliste nach der Rückkehr in die App nicht,
 *    dass jemand geantwortet hatte: Die Leitung stirbt beim Einfrieren ohne
 *    `close`, und nichts holte nach.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: {
      username: `${prefix}${suffix}`,
      password: 'passwort123',
      displayName: `${prefix.toUpperCase()} ${suffix}`,
    },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function anmelden(page: Page, sitzung: Sitzung, wurzel: string) {
  await page.goto(wurzel);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20_000 });
}

/**
 * Ein Push-Dienst zum Anfassen.
 *
 * Chromium ohne Google-Dienste hat keinen Push-Dienst: `subscribe` scheitert
 * dort IMMER (`AbortError`). Der erste Test zeigt, dass die App das jetzt
 * ehrlich sagt. Für den Weg bis „an“ ersetzt dieses Skript nur den letzten
 * Schritt – das Abo beim Dienst – durch eines mit echten Schlüsseln (P-256 per
 * WebCrypto, 16 Byte auth) und einer FCM-Adresse; alles davor (Erlaubnis,
 * Schlüssel vom Server, Service Worker) und danach (Anmelden, Prüfung der
 * Schlüssel und der Adresse auf dem Server) ist echt.
 */
function pushDienstNachbauen() {
  const b64 = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  let aktuell: PushSubscription | null = null;
  PushManager.prototype.getSubscription = async () => aktuell;
  PushManager.prototype.subscribe = async (optionen?: PushSubscriptionOptionsInit) => {
    const paar = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const p256dh = b64(await crypto.subtle.exportKey('raw', paar.publicKey));
    const auth = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    const schluessel = optionen?.applicationServerKey as Uint8Array;
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
    const abo = {
      endpoint,
      expirationTime: null,
      options: {
        userVisibleOnly: optionen?.userVisibleOnly,
        applicationServerKey: new Uint8Array(schluessel).buffer,
      },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
      unsubscribe: async () => {
        aktuell = null;
        return true;
      },
      getKey: () => null,
    };
    aktuell = abo as unknown as PushSubscription;
    return aktuell;
  };
}

test('ohne Push-Dienst sagt die App ehrlich, woran es liegt', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5173';
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin: new URL(wurzel).origin });
  const page = await context.newPage();
  await anmelden(page, await registrieren(http, 'psn'), wurzel);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.goto(`${wurzel}/profil/einstellungen`);
  const schalter = page.getByRole('switch', { name: /Push-Benachrichtigungen/ });
  await expect(schalter).toBeEnabled({ timeout: 15_000 });
  await schalter.click();
  // Früher: „Dieser Server verschickt gerade keine Benachrichtigungen“.
  await expect(page.getByText(/Das Gerät konnte kein Push-Abo anlegen/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Dieser Server verschickt gerade keine')).toHaveCount(0);
  await context.close();
});

test('Push einschalten mit erteilter Erlaubnis und selbst erzeugtem Schlüssel', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const schluessel = await (await http.get(`${API}/push/public-key`)).json();
  // Ohne VAPID_* in der Umgebung: an, mit einem P-256-Punkt (65 Byte).
  expect(schluessel.enabled).toBe(true);
  expect(schluessel.publicKey).toHaveLength(87);

  const wurzel = baseURL ?? 'http://localhost:5173';
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin: new URL(wurzel).origin });
  await context.addInitScript(pushDienstNachbauen);
  const page = await context.newPage();
  const ida = await registrieren(http, 'psh');
  await anmelden(page, ida, wurzel);

  // Der Service Worker muss stehen, sonst gibt es keinen PushManager.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

  await page.goto(`${wurzel}/profil/einstellungen`);
  const schalter = page.getByRole('switch', { name: /Push-Benachrichtigungen/ });
  await expect(schalter).toBeEnabled({ timeout: 15_000 });
  await schalter.click();

  await expect(page.getByText('Benachrichtigungen sind an')).toBeVisible({ timeout: 20_000 });
  await expect(schalter).toHaveAttribute('aria-checked', 'true');

  // Das Abo im Browser ist an GENAU den Schlüssel des Servers gebunden.
  const gebunden = await page.evaluate(async () => {
    const registrierung = await navigator.serviceWorker.ready;
    const abo = await registrierung.pushManager.getSubscription();
    const roh = abo?.options.applicationServerKey;
    if (!roh) return null;
    return btoa(String.fromCharCode(...new Uint8Array(roh)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  });
  expect(gebunden).toBe(schluessel.publicKey);

  // Der Server hat das Abo angenommen: Der Testversand findet ein Gerät
  // (ob FCM die erfundene Adresse annimmt, ist hier ohne Belang – gezählt
  // wird nur, was zugestellt wurde; es darf also 0 sein, aber kein Fehler).
  const test = await http.post(`${API}/push/test`, {
    headers: { authorization: `Bearer ${ida.accessToken}` },
  });
  expect(test.ok()).toBeTruthy();
  await context.close();
});

test('Chatliste holt nach stumm gestorbener Leitung beim Zurückkommen nach', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const ida = await registrieren(http, 'frz');
  const jan = await registrieren(http, 'frj');
  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: { authorization: `Bearer ${ida.accessToken}` },
      data: { type: 'direct', memberIds: [jan.user.id] },
    })
  ).json();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const context = await browser.newContext();
  // Jede Leitung merken, um sie später „einfrieren“ zu können.
  await context.addInitScript(() => {
    const Echt = window.WebSocket;
    const alle: WebSocket[] = [];
    (window as unknown as { __leitungen: WebSocket[] }).__leitungen = alle;
    window.WebSocket = new Proxy(Echt, {
      construct(ziel, argumente: [string, string?]) {
        const socket = new ziel(...argumente);
        alle.push(socket);
        return socket;
      },
    });
  });
  const page = await context.newPage();
  await anmelden(page, ida, wurzel);
  const zeile = page.locator(`a[href$="/chats/${chat.id}"]`);
  await expect(zeile).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __leitungen: WebSocket[] }).__leitungen.some(
          (socket) => socket.readyState === WebSocket.OPEN,
        ),
      ),
    )
    .toBe(true);

  // Einfrieren wie auf dem iPhone: Die Leitung steht auf OPEN, bringt aber
  // nichts mehr – und meldet kein `close`.
  const vorher = await page.evaluate(() => {
    const alle = (window as unknown as { __leitungen: WebSocket[] }).__leitungen;
    for (const socket of alle) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.send = () => {};
    }
    return alle.length;
  });

  const text = `Antwort ${Date.now()}`;
  const gesendet = await http.post(`${API}/conversations/${chat.id}/messages`, {
    headers: { authorization: `Bearer ${jan.accessToken}` },
    data: { type: 'text', body: text, clientId: `frz-${Date.now()}` },
  });
  expect(gesendet.ok()).toBeTruthy();

  // Über die tote Leitung kommt nichts an.
  await page.waitForTimeout(1_500);
  await expect(zeile).not.toContainText(text);

  // Zurück in den Vordergrund.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // Vorschau und Ungelesen-Zähler stimmen – ohne Neuladen.
  await expect(zeile).toContainText(text, { timeout: 10_000 });
  await expect(zeile.locator('.chat-badge')).toHaveText('1');

  // Und die tote Leitung wurde ersetzt (ping ohne Antwort → neu).
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as { __leitungen: WebSocket[] }).__leitungen.length),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(vorher);

  // Über die neue Leitung kommt wieder alles live an.
  const zweiter = `Noch eine ${Date.now()}`;
  await http.post(`${API}/conversations/${chat.id}/messages`, {
    headers: { authorization: `Bearer ${jan.accessToken}` },
    data: { type: 'text', body: zweiter, clientId: `frz2-${Date.now()}` },
  });
  await expect(zeile).toContainText(zweiter, { timeout: 10_000 });
  await expect(zeile.locator('.chat-badge')).toHaveText('2');
  await context.close();
});
