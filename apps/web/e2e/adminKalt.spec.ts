import { expect, request, test, type Page } from '@playwright/test';

/**
 * Verwaltung → „Kalte Ablage (Storage Box)“: die zwei Knöpfe.
 *
 * Läuft gegen eine API mit `KALT_TREIBER=lokal` (ein zweites Verzeichnis statt
 * der Box) und `ADMIN_PASSWORD`. Das Passwort steht in `E2E_ADMIN_PASSWORD`.
 * Geprüft wird, was die Oberfläche leistet: beide Läufe starten, das Ergebnis
 * zeigt Befunde, Zeiten und die Rate – und ein Nicht-Admin kommt gar nicht erst
 * in die Verwaltung.
 */
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;
const PASSWORT = process.env.E2E_ADMIN_PASSWORT ?? 'admin-passwort-e2e';

async function admin(page: Page, baseURL: string) {
  const http = await request.newContext();
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: { username: `adm${suffix}`, password: 'passwort123', displayName: `Admin ${suffix}` },
  });
  expect(antwort.ok()).toBeTruthy();
  const sitzung = await antwort.json();
  // Verwaltung aufschliessen (setzt users.is_admin für dieses Konto).
  const auf = await http.post(`${API}/admin/unlock`, {
    headers: { authorization: `Bearer ${sitzung.accessToken}` },
    data: { password: PASSWORT },
  });
  expect(auf.ok(), `Aufschliessen: ${auf.status()}`).toBeTruthy();
  await page.goto(baseURL);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    { accessToken: sitzung.accessToken, expiresAt: Date.now() + 3_600_000 },
  );
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
}

test('Verwaltung: Box prüfen (64 MiB) und Konsistenz prüfen zeigen Befunde, Zeiten und Rate', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const wurzel = baseURL ?? 'http://localhost:5173';
  await admin(page, wurzel);
  await page.goto(`${wurzel}/verwaltung`);
  await expect(page.getByRole('heading', { name: 'Kalte Ablage (Storage Box)' })).toBeVisible({
    timeout: 15_000,
  });

  // 1. Die Box-Probe.
  await page.getByRole('button', { name: 'Box prüfen (64 MiB)' }).click();
  const ergebnis = page.getByTestId('kalt-ergebnis');
  await expect(ergebnis).toBeVisible({ timeout: 120_000 });
  await expect(ergebnis).toContainText('Grosse Datei schreiben');
  await expect(ergebnis).toContainText('MB/s');
  await expect(ergebnis).toContainText('Gesamtdauer');
  await expect(ergebnis).toContainText('Löschen');
  await expect(ergebnis).not.toContainText('✗');

  // 2. Die Konsistenz: frische Installation – nichts fern, nichts verwaist.
  await page.getByRole('button', { name: 'Konsistenz prüfen' }).click();
  await expect(ergebnis).toContainText('Fehlende Dateien', { timeout: 120_000 });
  await expect(ergebnis).toContainText('Prüfsummen-Stichprobe');
  await expect(ergebnis).toContainText('Datenbank und Box stimmen überein');
});

test('Verwaltung: Wer kein Admin ist, bekommt die Knöpfe nicht zu sehen', async ({
  page,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: { username: `usr${suffix}`, password: 'passwort123', displayName: `Nutzer ${suffix}` },
  });
  const sitzung = await antwort.json();
  // Auch direkt über die API: 403.
  const direkt = await http.get(`${API}/admin/storage-check/konsistenz`, {
    headers: { authorization: `Bearer ${sitzung.accessToken}` },
  });
  expect(direkt.status()).toBe(403);
  await page.goto(wurzel);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    { accessToken: sitzung.accessToken, expiresAt: Date.now() + 3_600_000 },
  );
  await page.goto(`${wurzel}/verwaltung`);
  await expect(page.getByRole('button', { name: 'Konsistenz prüfen' })).toHaveCount(0);
});
