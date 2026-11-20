import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Eine Nachricht mit Anhang kommt genau einmal an – auch wenn mittendrin das
 * Netz reisst und die Seite neu geladen wird.
 *
 * Zwei Stellen, an denen es reissen kann:
 *
 * 1. NACH dem Festschreiben beim Server, bevor die Antwort ankommt. Der
 *    Client hält die Nachricht für ungesendet; nach dem Neuladen schickt die
 *    Outbox sie mit demselben `clientId` noch einmal, und der Server gibt das
 *    Original zurück. Es darf keine zweite Nachricht entstehen.
 * 2. Beim Hochladen des Anhangs. Die Nachricht ist noch gar nicht beim
 *    Server; nach dem Neuladen geht sie aus der Outbox (IndexedDB) hinaus. Es
 *    darf keine verloren gehen.
 *
 * Gezählt wird beim Empfänger, nach SEINEM Neuladen – also das, was der
 * Server wirklich hat, nicht ein Zwischenstand im Speicher.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRMAAAA' +
    'PsAQVj3vJTAAAAAElFTkSuQmCC',
  'base64',
);

function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

async function signUp(browser: Browser, user: ReturnType<typeof credentials>): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(user.username);
  await page.getByLabel('Anzeigename').fill(user.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return page;
}

async function chatMit(page: Page, gegenueber: ReturnType<typeof credentials>): Promise<void> {
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(gegenueber.username);
  await page.getByText(gegenueber.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

async function fotoSenden(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await page.getByText('Foto/Video').click();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: /^Senden \(/ }).click();
}

/** Wie viele Bildnachrichten der Empfänger nach dem Neuladen sieht. */
async function bilderBeimEmpfaenger(page: Page, absender: string): Promise<number> {
  await page.reload();
  await page.getByText(absender).first().click();
  await expect(page.locator('.media-image').first()).toBeVisible({ timeout: 30_000 });
  // Kurz warten: Eine zweite Nachricht käme mit derselben Seite.
  await page.waitForTimeout(1_500);
  return page.locator('.media-image').count();
}

test('Netz reisst nach dem Festschreiben: genau eine Nachricht', async ({ browser }) => {
  const alice = credentials('einmal');
  const bob = credentials('empf');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);
  await chatMit(alicePage, bob);

  // Die Anfrage geht durch, der Server schreibt fest – die Antwort aber
  // kommt nie an, und das Gerät ist danach offline.
  let durchgelassen = 0;
  await alicePage.route('**/api/v1/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST' || durchgelassen > 0) return route.fallback();
    durchgelassen += 1;
    const antwort = await route.fetch();
    expect(antwort.status()).toBe(201);
    await alicePage.context().setOffline(true);
    await route.abort('internetdisconnected');
  });

  await fotoSenden(alicePage, 'einmal.png');
  await expect.poll(() => durchgelassen, { timeout: 30_000 }).toBe(1);

  // Neu laden, sobald das Netz wieder da ist – die Outbox sendet erneut.
  await alicePage.context().setOffline(false);
  await alicePage.reload();
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.locator('.media-image').first()).toBeVisible({ timeout: 30_000 });
  await expect(alicePage.getByText(/wird gesendet/i)).toHaveCount(0, { timeout: 30_000 });
  await alicePage.waitForTimeout(1_500);
  await expect(alicePage.locator('.media-image')).toHaveCount(1);

  expect(await bilderBeimEmpfaenger(bobPage, alice.displayName)).toBe(1);

  await alicePage.context().close();
  await bobPage.context().close();
});

test('Netz reisst beim Hochladen: die Nachricht kommt nach dem Neuladen genau einmal', async ({
  browser,
}) => {
  const alice = credentials('upload');
  const bob = credentials('empf');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);
  await chatMit(alicePage, bob);

  // Der erste Upload bricht ab, das Gerät ist offline.
  let abgebrochen = 0;
  await alicePage.route('**/api/v1/media/uploads**', async (route) => {
    if (abgebrochen > 0) return route.fallback();
    abgebrochen += 1;
    await alicePage.context().setOffline(true);
    await route.abort('internetdisconnected');
  });

  await fotoSenden(alicePage, 'abbruch.png');
  await expect.poll(() => abgebrochen, { timeout: 30_000 }).toBe(1);
  // Die Outbox muss in IndexedDB stehen, bevor neu geladen wird.
  await expect
    .poll(
      () =>
        alicePage.evaluate(
          () =>
            new Promise<number>((fertig) => {
              const anfrage = indexedDB.open('initiative');
              anfrage.onsuccess = () => {
                const zaehlen = anfrage.result
                  .transaction('outbox', 'readonly')
                  .objectStore('outbox')
                  .count();
                zaehlen.onsuccess = () => fertig(zaehlen.result);
              };
              anfrage.onerror = () => fertig(-1);
            }),
        ),
      { timeout: 15_000 },
    )
    .toBe(1);

  await alicePage.context().setOffline(false);
  await alicePage.reload();
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.locator('.media-image').first()).toBeVisible({ timeout: 30_000 });
  await expect(alicePage.getByText(/wird gesendet/i)).toHaveCount(0, { timeout: 30_000 });

  expect(await bilderBeimEmpfaenger(bobPage, alice.displayName)).toBe(1);

  await alicePage.context().close();
  await bobPage.context().close();
});
