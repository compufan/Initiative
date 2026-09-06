import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Zwei Nutzer, ein Chat, eine Nachricht.
 *
 * Dieser Test fährt den kompletten Stapel: PWA → REST-API → Postgres → WebSocket
 * → zweite PWA-Instanz. Er beweist, dass Realtime wirklich durchläuft.
 */

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

test('zwei Nutzer chatten in Echtzeit', async ({ browser }) => {
  const alice = credentials('alice');
  const bob = credentials('bob');

  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  // Alice legt einen Direktchat mit Bob an.
  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();

  const composer = alicePage.getByPlaceholder('Nachricht schreiben');
  await expect(composer).toBeVisible();

  const text = `Hallo Bob, ${Date.now()}`;
  await composer.fill(text);
  await alicePage.getByRole('button', { name: 'Senden' }).click();
  await expect(alicePage.getByText(text)).toBeVisible();

  // Bob bekommt den Chat und die Nachricht über den WebSocket – ohne Reload.
  await expect(bobPage.getByText(alice.displayName).first()).toBeVisible({ timeout: 15_000 });
  await expect(bobPage.getByText(text).first()).toBeVisible({ timeout: 15_000 });

  // Bob öffnet den Chat und antwortet.
  await bobPage.getByText(alice.displayName).first().click();
  const reply = `Servus Alice, ${Date.now()}`;
  await bobPage.getByPlaceholder('Nachricht schreiben').fill(reply);
  await bobPage.getByRole('button', { name: 'Senden' }).click();

  // Und Alice sieht die Antwort live im offenen Chat.
  await expect(alicePage.getByText(reply)).toBeVisible({ timeout: 15_000 });

  await alicePage.context().close();
  await bobPage.context().close();
});

test('legt eine Gruppe an und zeigt sie beiden Mitgliedern', async ({ browser }) => {
  const owner = credentials('owner');
  const guest = credentials('guest');

  const ownerPage = await signUp(browser, owner);
  const guestPage = await signUp(browser, guest);

  await ownerPage.getByRole('button', { name: 'Neuer Chat' }).click();
  await ownerPage.getByRole('tab', { name: /Gruppe/ }).click();
  await ownerPage.getByLabel('Gruppenname').fill('Testgruppe');
  await ownerPage.getByPlaceholder('Mitglieder suchen').fill(guest.username);
  await ownerPage.getByText(guest.displayName).first().click();
  await ownerPage.getByRole('button', { name: /Gruppe erstellen|Erstellen/ }).click();

  await expect(ownerPage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await expect(guestPage.getByText('Testgruppe').first()).toBeVisible({ timeout: 15_000 });

  await ownerPage.context().close();
  await guestPage.context().close();
});

test('ein archivierter Chat ist wiederzufinden – das Archiv war eine Einbahnstrasse', async ({
  browser,
}) => {
  /*
   * „Chat archivieren" nahm den Chat aus der Liste, und damit war er weg:
   * `api.conversations.list()` fragt ohne Argument nur die unarchivierten ab,
   * und eine Archivansicht gab es nirgends. Der Weg zurück steht in der
   * Chat-Info – die man nur AUS dem Chat heraus öffnet, den man nicht mehr
   * öffnen kann.
   *
   * Der Test geht denselben Weg wie ein Mensch: archivieren, feststellen dass
   * er fort ist, ihn im Archiv wiederfinden, zurückholen.
   */
  const alice = credentials('arch');
  const bob = credentials('arziel');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByPlaceholder('Nachricht schreiben').fill('Hallo');
  await page.getByRole('button', { name: 'Senden' }).click();

  // Archivieren aus der Chat-Info heraus.
  await page
    .getByRole('button', { name: /Chat-Info|Info/ })
    .first()
    .click();
  await page.getByRole('button', { name: /Chat archivieren/ }).click();

  await page.goto('/chats');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  // Fort aus der Liste – so weit war es schon immer richtig.
  await expect(page.getByText(bob.displayName)).toHaveCount(0);

  // Und jetzt der Teil, der gefehlt hat: wiederfinden.
  await page.getByRole('button', { name: 'Archivierte Chats' }).click();
  await expect(page.getByRole('heading', { name: 'Archiv' })).toBeVisible();
  await expect(page.getByText(bob.displayName).first()).toBeVisible({ timeout: 15_000 });

  // Von dort hinein und zurückholen.
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page
    .getByRole('button', { name: /Chat-Info|Info/ })
    .first()
    .click();
  await page.getByRole('button', { name: /Aus dem Archiv holen/ }).click();

  await page.goto('/chats');
  await expect(page.getByText(bob.displayName).first()).toBeVisible({ timeout: 15_000 });

  await page.close();
});
