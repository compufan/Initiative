import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Ein Foto im Chat – und der Beweis, dass es wirklich ankommt.
 *
 * Der Test schaut ausdrücklich nicht nur, ob ein `<img>` im Baum steht. Genau
 * daran ist der Fehler vorbeigekommen, den der Anwender gemeldet hat: Das
 * Element war da, nur lud es nichts. Deshalb wird `naturalWidth` geprüft – der
 * Browser setzt den Wert erst, wenn er die Bytes wirklich hat.
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

/** Ein winziges, aber echtes PNG (2x2, rot) – kein Platzhalter-Byte. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRMAAAA' +
    'PsAQVj3vJTAAAAAElFTkSuQmCC',
  'base64',
);

test('ein Foto im Chat wird wirklich angezeigt', async ({ browser }) => {
  const alice = credentials('foto');
  const bob = credentials('empf');

  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  // Anhang-Menü → „Foto/Video“ → Datei wählen → senden.
  await alicePage.getByRole('button', { name: 'Anhang hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'testbild.png',
    mimeType: 'image/png',
    buffer: PNG,
  });

  // Der Knopf IM Blatt, nicht der im Eingabefeld darunter: Auf einem
  // Handyschirm liegen beide uebereinander, und `.last()` erwischte den
  // ausgegrauten des Eingabefelds.
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();

  // --- Die eigentliche Prüfung ------------------------------------------
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });

  // Steht da nur der Rahmen, oder sind wirklich Bytes angekommen?
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
      message: 'Das Bild-Element ist da, aber der Browser hat keine Bytes bekommen.',
    })
    .toBeGreaterThan(0);

  // Und es muss auch eine Fläche haben. Genau hier ist der gemeldete Fehler
  // durchgerutscht: Das Element war vorhanden, geladen und richtig verdrahtet –
  // nur 0 Pixel breit, weil sich Blase und Rahmen gegenseitig nach der Breite
  // fragten. Ohne diese Zeile faellt das keinem Test auf.
  const breite = await bild.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(breite, 'Das Bild hat keine Fläche – Blase und Rahmen kennen ihre Breite nicht.')
    .toBeGreaterThan(150);

  await expect(alicePage.getByText('Bild nicht verfügbar')).toHaveCount(0);

  // Beim Empfänger genauso – über den WebSocket, ohne Neuladen.
  await bobPage.getByText(alice.displayName).first().click();
  const bildBeiBob = bobPage.locator('.media-image').first();
  await expect(bildBeiBob).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bildBeiBob.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  await alicePage.context().close();
  await bobPage.context().close();
});

/**
 * Der zweite Teil desselben Fehlers.
 *
 * Mit Bildunterschrift war das Foto sichtbar – aber nur, weil der TEXT der
 * Blase eine Breite gab. Ein Wort Unterschrift ergab ein 127 Pixel breites
 * Foto, ein langer Satz ein breiteres. Die Größe eines Bildes darf nicht davon
 * abhängen, wie viel jemand dazuschreibt.
 */
test('die Bildunterschrift bestimmt nicht die Bildgröße', async ({ browser }) => {
  const alice = credentials('kurz');
  const bob = credentials('ziel');

  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  const senden = async (unterschrift: string) => {
    await alicePage.getByRole('button', { name: 'Anhang hinzufügen' }).click();
    await alicePage.getByText('Foto/Video').click();
    await alicePage.locator('input[type=file]').setInputFiles({
      name: 'testbild.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    if (unterschrift) await alicePage.getByLabel('Bildunterschrift').fill(unterschrift);
    await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
    await expect
      .poll(async () => alicePage.locator('.media-image').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
  };

  await senden('ok');
  await alicePage.waitForTimeout(1500);
  const schmal = await alicePage
    .locator('.media-image')
    .last()
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));

  await senden('Eine deutlich längere Bildunterschrift, die über mehrere Zeilen läuft');
  await alicePage.waitForTimeout(1500);
  const breit = await alicePage
    .locator('.media-image')
    .last()
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));

  expect(schmal).toBeGreaterThan(150);
  expect(breit).toBe(schmal);

  await alicePage.context().close();
});
