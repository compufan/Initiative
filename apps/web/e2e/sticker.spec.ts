import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Sticker müssen ohne Suchen erreichbar sein.
 *
 * Der Anwender meldete, er finde im Chat keine Möglichkeit, einen Sticker zu
 * senden. Die Kette war vollständig verdrahtet – nur lag der einzige Einstieg
 * hinter einem Knopf mit der Aufschrift „Anhang hinzufügen“. Danach sucht
 * niemand, der einen Sticker schicken will.
 *
 * Der Test prüft deshalb nicht die Technik dahinter, sondern die Auffindbarkeit:
 * einen Knopf, der Sticker beim Namen nennt, direkt in der Eingabezeile.
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

test('Sticker sind aus der Eingabezeile heraus erreichbar', async ({ browser }) => {
  const alice = credentials('stk');
  const bob = credentials('ziel');

  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  // Ein Knopf, der „Sticker“ heisst – ohne dass man vorher irgendein Menü
  // öffnen muss. Genau das fehlte.
  const stickerKnopf = page.getByRole('button', { name: 'Sticker', exact: true });
  await expect(stickerKnopf).toBeVisible();

  await stickerKnopf.click();
  await expect(page.getByRole('heading', { name: 'Sticker' })).toBeVisible();

  // Und aus dem leeren Zustand heraus muss man zum Studio kommen – sonst
  // steht ein frisches Konto vor einem leeren Blatt.
  await expect(page.getByRole('button', { name: /Sticker erstellen/ })).toBeVisible();
});

test('das Menü führt weiterhin vollständig zu allem', async ({ browser }) => {
  // Der eigene Knopf ist eine Abkürzung, kein Ersatz: Es soll genau einen
  // Ort geben, an dem alles steht, was man einer Nachricht beilegen kann.
  const alice = credentials('menu');
  const bob = credentials('ziel');

  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  // Ausdrücklich IM Blatt suchen: „Sticker“ gibt es jetzt zweimal – einmal als
  // Abkürzung in der Zeile, einmal hier. Das ist gewollt und darf den Test
  // nicht stolpern lassen.
  const menue = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Hinzufügen' }) });
  for (const eintrag of ['Kamera', 'Foto/Video', 'Sprachnachricht', 'Datei', 'Sticker']) {
    await expect(menue.getByRole('button', { name: eintrag, exact: true })).toBeVisible();
  }
});
