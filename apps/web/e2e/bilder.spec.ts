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

/**
 * Ein mittelgraues PNG, 8 × 8, Wert 90.
 *
 * Für die Tonwerte braucht es genau das und kein rotes: Ein gesättigtes Rot
 * (255, 0, 0) ändert sich unter „Belichtung“ nicht messbar – der rote Kanal
 * steht schon am Anschlag, die anderen beiden auf null. Der Mittelwert bleibt
 * bei 85, egal wie hell man dreht. Genau daran ist die erste Fassung dieses
 * Tests gescheitert, und sie hatte recht: Sie mass nur das falsche Bild.
 */
const GRAU_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR42mOIwgEYhpYEAGBOQ4HXjRn7AAAAAElFTkSuQmCC',
  'base64',
);

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
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
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
  expect(
    breite,
    'Das Bild hat keine Fläche – Blase und Rahmen kennen ihre Breite nicht.',
  ).toBeGreaterThan(150);

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
    await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
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

test('der Ton-Reiter im Bildeditor verändert das Bild wirklich', async ({ browser }) => {
  /*
   * Stufe 3: Belichtung, Kontrast, Farbe.
   *
   * Dass die Rechnung stimmt, prüft `ton.spec.ts` bis auf zwei Stufen von
   * 255 genau. Hier geht es um das andere Ende: Kommt der Regler überhaupt
   * bis zur Leinwand? Ein Reiter mit elf Schiebern, die nichts bewirken,
   * wäre kein Fortschritt, sondern eine Enttäuschung mehr.
   */
  const alice = credentials('ton');
  const bob = credentials('tonempf');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau.png',
    mimeType: 'image/png',
    buffer: GRAU_PNG,
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();

  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  // Über die Lupe in den Editor – der Weg, den auch der Anwender geht.
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  const leinwand = alicePage.locator('.bild-leinwand');
  await expect(leinwand).toBeVisible({ timeout: 30_000 });

  /*
   * Zuerst: Liegt der Editor überhaupt OBEN?
   *
   * Er tat es lange nicht. Mit z-index 60 lag er unter dem Betrachter (70)
   * und dessen zu 96 % deckendem Grund – man sah ein fahles Gespenst der
   * Knöpfe, die Leinwand gar nicht. Bedienen liess sich nichts: An der
   * Stelle des Reiters „Ton“ lag `div.media-zoom`. „Bild bearbeiten“ war aus
   * dem Foto heraus unbenutzbar, und zwar für Editor und Sticker-Studio
   * gleichermassen.
   *
   * Geprüft wird die Stapelung selbst und nicht nur die Bedienbarkeit: Ein
   * `inert` am Betrachter macht ihn zwar durchlässig für Finger, aber nicht
   * durchsichtig. Beides muss stimmen.
   */
  const stapel = await alicePage.evaluate(() => {
    const zahl = (auswahl: string) => {
      const el = document.querySelector(auswahl);
      if (!el) return null;
      return Number(getComputedStyle(el).zIndex);
    };
    return { editor: zahl('.bild-editor'), betrachter: zahl('.media-lightbox') };
  });
  expect(stapel.editor, 'der Editor hat keine Stapelebene').not.toBeNull();
  expect(stapel.betrachter).not.toBeNull();
  expect(
    stapel.editor ?? 0,
    'der Bildeditor liegt unter dem Bildbetrachter – man sieht ihn nicht',
  ).toBeGreaterThan(stapel.betrachter ?? 0);

  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = alicePage.getByRole('slider', { name: /Belichtung/ });
  await expect(belichtung).toBeVisible();
  await expect(belichtung).toHaveValue('0');
  // Elf Regler, nicht zehn und nicht zwölf.
  await expect(alicePage.locator('.bild-panel.ist-ton .bild-schieber')).toHaveCount(11);

  /** Die mittlere Helligkeit dessen, was auf der Leinwand steht. */
  const helligkeit = async () =>
    leinwand.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      const d = ctx?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return -1;
      let summe = 0;
      for (let i = 0; i < d.length; i += 4) summe += d[i] + d[i + 1] + d[i + 2];
      return summe / (d.length / 4) / 3;
    });

  const vorher = await helligkeit();
  // Das graue Testbild kommt unverändert an: 90, nicht 0 und nicht 255.
  expect(vorher).toBeGreaterThan(80);
  expect(vorher).toBeLessThan(100);

  /*
   * Zwei Blenden mehr Licht. Aus 90 werden rund 178 – vervierfachtes Licht,
   * nicht ein vervierfachter Zahlenwert. Genau das ist der Unterschied
   * zwischen einer Rechnung im Licht und einer in der Anzeige, und er ist
   * hier messbar.
   */
  await belichtung.fill('2');
  await expect(belichtung).toHaveValue('2');
  await expect.poll(helligkeit, { timeout: 5_000 }).toBeGreaterThan(165);
  expect(await helligkeit()).toBeLessThan(195);

  // „Zurücksetzen“ bringt es wieder auf den Ausgangswert.
  await alicePage.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(belichtung).toHaveValue('0');
  await expect.poll(helligkeit, { timeout: 5_000 }).toBeCloseTo(vorher, -0.5);

  await alicePage.context().close();
});
