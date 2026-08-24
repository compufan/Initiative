import { expect, test } from '@playwright/test';

/** Frische Zugangsdaten pro Lauf, damit Tests wiederholbar bleiben. */
function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix} ${suffix}`,
  };
}

async function register(
  page: import('@playwright/test').Page,
  user: ReturnType<typeof credentials>,
) {
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(user.username);
  await page.getByLabel('Anzeigename').fill(user.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  // Erst weitermachen, wenn die Anmeldung wirklich durch ist – sonst bricht eine
  // sofort folgende Navigation die laufende Anfrage ab.
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
}

/** Meldet den aktuellen Benutzer über das Profil ab. */
async function logout(page: import('@playwright/test').Page) {
  await page.goto('/profil');
  await page
    .getByRole('button', { name: /Abmelden/ })
    .first()
    .click();
  // Der Abmelde-Dialog fragt nach, weil dabei die lokalen Chats gelöscht werden.
  await page.getByRole('dialog').getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
}

test.describe('Anmeldung', () => {
  test('registriert ein Konto und landet in den Chats', async ({ page }) => {
    const user = credentials('test');
    await register(page, user);

    // Nach der Registrierung ist die Chatliste sichtbar.
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await expect(page).toHaveURL(/\/chats$/);
  });

  test('weist falsche Passwörter ab', async ({ page }) => {
    const user = credentials('wrong');
    await register(page, user);

    await logout(page);

    await page.getByLabel('Benutzername').fill(user.username);
    await page.getByLabel('Passwort', { exact: true }).fill('falsches-passwort');
    await page.getByRole('button', { name: 'Anmelden' }).click();

    await expect(page.getByRole('alert')).toContainText(/falsch/i);
  });

  test('meldet sich mit gültigen Daten wieder an', async ({ page }) => {
    const user = credentials('again');
    await register(page, user);
    await logout(page);

    await page.getByLabel('Benutzername').fill(user.username);
    await page.getByLabel('Passwort', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Anmelden' }).click();

    // Nach dem Anmelden bleibt die zuletzt geöffnete Route stehen – der
    // Tab-Leiste sieht man an, dass die Sitzung wieder steht.
    await expect(page.getByRole('link', { name: /Chats/ })).toBeVisible();
    await page.getByRole('link', { name: /Chats/ }).click();
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  });
});

test.describe('PWA', () => {
  test('liefert ein gültiges Manifest und registriert den Service Worker', async ({ page }) => {
    await page.goto('/');

    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBeTruthy();
    const parsed = await manifest.json();
    expect(parsed.name).toBe('Initiative');
    expect(parsed.display).toBe('standalone');
    expect(parsed.icons.length).toBeGreaterThanOrEqual(2);

    // Der Service Worker wird beim Start registriert (im Dev-Modus als Modul).
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration);
    });
    expect(registered).toBeTruthy();
  });
});

test.describe('Teilen-Ziel', () => {
  test('zeigt eine Chatauswahl, wenn nichts mehr im Zwischenspeicher liegt', async ({ page }) => {
    const user = credentials('share');
    await register(page, user);

    // Der Service Worker legt geteilte Inhalte kurz beiseite; ohne gültige id
    // muss die Seite das sauber auffangen statt leer zu bleiben.
    await page.goto('/teilen?share=unbekannt');
    await expect(page.getByRole('heading', { name: 'Teilen' })).toBeVisible();
    await expect(page.getByText('Nichts zum Teilen')).toBeVisible();
  });

  test('übernimmt Text und URL aus den Query-Parametern', async ({ page }) => {
    const user = credentials('sharetext');
    await register(page, user);

    await page.goto('/teilen?title=Schau%20mal&text=Das%20hier&url=https%3A%2F%2Fexample.com');
    await expect(page.getByRole('heading', { name: 'Teilen' })).toBeVisible();
    await expect(page.getByText('Das wird gesendet')).toBeVisible();
    await expect(page.getByText('https://example.com')).toBeVisible();
  });
});
