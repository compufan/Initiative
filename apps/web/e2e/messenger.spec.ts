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
