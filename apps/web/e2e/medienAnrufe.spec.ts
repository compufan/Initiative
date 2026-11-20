import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Anrufe zwischen zwei Browsern, Medienübersicht, globaler Spieler und
 * Videonachricht – gegen den echten Server. Kamera und Mikrofon kommen aus
 * Chromiums Testgeräten (`--use-fake-device-for-media-stream`).
 *
 * # Umgebung
 *
 * Anruf, Sprach- und Videonachricht brauchen Chromium mit
 * `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` und den
 * Rechten `camera`/`microphone`. `playwright.config.ts` setzt beides. Eine
 * eigene Konfiguration ohne die Schalter (etwa gegen einen zweiten Server)
 * hat in einem Container keine Kamera – dann überspringen sich diese drei
 * Tests mit Grund, statt rot zu werden. Erkannt wird das per Abfrage
 * (`getUserMedia`), nicht per Schalter: Wer eine echte Kamera hat, testet
 * eben mit der.
 */

const OHNE_GERAETE =
  'Kein Mikrofon/keine Kamera im Browser – Chromium mit --use-fake-ui-for-media-stream ' +
  '--use-fake-device-for-media-stream starten (playwright.config.ts tut das)';

let geraeteDa: boolean | undefined;

/** Ob der Browser Kamera und Mikrofon liefert. Einmal je Lauf gefragt. */
async function medienGeraeteDa(browser: Browser): Promise<boolean> {
  if (geraeteDa !== undefined) return geraeteDa;
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    const page = await context.newPage();
    // Eine Seite der App: getUserMedia gibt es nur in einem sicheren Kontext.
    await page.goto('/');
    geraeteDa = await page.evaluate(async () => {
      try {
        const strom = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        strom.getTracks().forEach((spur) => spur.stop());
        return true;
      } catch {
        return false;
      }
    });
  } finally {
    await context.close();
  }
  return geraeteDa;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function konto(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

type Konto = ReturnType<typeof konto>;

async function registrieren(browser: Browser, wer: Konto): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(wer.username);
  await page.getByLabel('Anzeigename').fill(wer.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(wer.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return page;
}

async function direktchat(page: Page, mit: Konto): Promise<void> {
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(mit.username);
  await page.getByText(mit.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

async function senden(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('Nachricht schreiben').fill(text);
  await page.getByRole('button', { name: 'Senden' }).click();
}

async function chatOeffnen(page: Page, name: string): Promise<void> {
  await page.goto('/chats');
  await page.getByText(name).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

const anrufStatus = (page: Page) => page.locator('#anruf-status');

test('zwei Browser telefonieren: verbunden, auflegen, verpasster Anruf', async ({ browser }) => {
  test.skip(!(await medienGeraeteDa(browser)), OHNE_GERAETE);
  const anna = konto('anna');
  const bodo = konto('bodo');
  const annaSeite = await registrieren(browser, anna);
  const bodoSeite = await registrieren(browser, bodo);

  await direktchat(annaSeite, bodo);
  await senden(annaSeite, 'Kann ich dich anrufen?');
  await chatOeffnen(bodoSeite, anna.displayName);

  // --- Anruf mit Video: klingeln, annehmen, verbunden --------------------
  await annaSeite.getByRole('button', { name: 'Videoanruf' }).click();
  await expect(anrufStatus(annaSeite)).toContainText(/Ruft an|Klingelt/);
  const annehmen = bodoSeite.getByRole('button', { name: 'Annehmen' });
  await expect(annehmen).toBeVisible({ timeout: 15_000 });
  await expect(bodoSeite.getByRole('dialog')).toContainText(anna.displayName);
  await annehmen.click();
  await expect(anrufStatus(annaSeite)).toContainText('Verbunden', { timeout: 30_000 });
  await expect(anrufStatus(bodoSeite)).toContainText('Verbunden', { timeout: 30_000 });
  // Die Bedienung im Gespräch.
  await expect(annaSeite.getByRole('button', { name: 'Stumm' })).toBeVisible();
  await annaSeite.getByRole('button', { name: 'Stumm' }).click();
  await expect(annaSeite.getByRole('button', { name: 'Stumm' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(annaSeite.getByRole('button', { name: 'Kamera wechseln' })).toBeVisible();
  // Das Bild des anderen kommt wirklich an.
  await expect
    .poll(
      () =>
        bodoSeite
          .locator('video.anruf-fern')
          .evaluate((v: HTMLVideoElement) => v.videoWidth)
          .catch(() => 0),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await annaSeite.waitForTimeout(1200);

  // --- Auflegen: beide sehen das Ende, im Chat steht die Dauer ------------
  await annaSeite.getByRole('button', { name: 'Auflegen' }).click();
  await expect(anrufStatus(bodoSeite)).toContainText('Anruf beendet', { timeout: 15_000 });
  await expect(
    annaSeite.locator('.msg-system').filter({ hasText: /Videoanruf, 0:0\d/ }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    bodoSeite.locator('.msg-system').filter({ hasText: /Videoanruf, 0:0\d/ }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(annaSeite.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

  // --- Verpasst: Anna ruft, Bodo nimmt nicht ab, Anna legt auf ----------
  await annaSeite.getByRole('button', { name: 'Anrufen' }).click();
  await expect(bodoSeite.getByRole('button', { name: 'Annehmen' })).toBeVisible({
    timeout: 15_000,
  });
  await annaSeite.getByRole('button', { name: 'Auflegen' }).click();
  await expect(bodoSeite.getByRole('button', { name: 'Annehmen' })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    bodoSeite.locator('.msg-system').filter({ hasText: 'Verpasster Anruf' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    annaSeite.locator('.msg-system').filter({ hasText: 'Anruf nicht angenommen' }),
  ).toBeVisible({ timeout: 15_000 });

  // --- Ablehnen ----------------------------------------------------------
  await annaSeite.getByRole('button', { name: 'Anrufen' }).click();
  await bodoSeite.getByRole('button', { name: 'Ablehnen' }).click();
  await expect(anrufStatus(annaSeite)).toContainText('Abgelehnt', { timeout: 15_000 });
});

test('Medien-Reiter in der Chat-Info: Fotos, Links, Sprung zur Nachricht', async ({ browser }) => {
  const anna = konto('mona');
  const bodo = konto('mirk');
  const annaSeite = await registrieren(browser, anna);
  await registrieren(browser, bodo);
  await direktchat(annaSeite, bodo);

  await annaSeite.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await annaSeite.getByText('Foto/Video').click();
  // HD-Schalter ist da und steht auf Standard.
  await expect(annaSeite.getByRole('switch')).not.toBeChecked();
  await annaSeite.locator('input[type=file][accept="image/*,video/*"]').setInputFiles({
    name: 'urlaub.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await annaSeite.getByRole('button', { name: /^Senden \(/ }).click();
  await expect(annaSeite.locator('.media-image').first()).toBeVisible({ timeout: 30_000 });
  await senden(annaSeite, 'Hier der Plan: https://example.org/plan und mehr');
  await expect(annaSeite.locator('.msg-row').filter({ hasText: 'Hier der Plan' })).toBeVisible();

  await annaSeite.getByRole('button', { name: 'Chat-Info öffnen' }).click();
  await annaSeite.getByRole('button', { name: /Medien, Links und Dokumente/ }).click();
  const medienTab = annaSeite.getByRole('tab', { name: 'Medien' });
  await expect(medienTab).toHaveAttribute('aria-selected', 'true');
  await expect(annaSeite.locator('.mu-kachel')).toHaveCount(1, { timeout: 15_000 });

  // Tastatur: Pfeil nach rechts wechselt den Reiter.
  await medienTab.focus();
  await annaSeite.keyboard.press('ArrowRight');
  await expect(annaSeite.getByRole('tab', { name: 'Dokumente' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(annaSeite.getByText('Keine Dokumente')).toBeVisible();

  await annaSeite.getByRole('tab', { name: 'Links' }).click();
  await expect(annaSeite.getByRole('link', { name: 'example.org/plan' })).toBeVisible();
  await annaSeite.getByRole('tab', { name: 'Sprachnachrichten' }).click();
  await expect(annaSeite.getByText('Keine Sprachnachrichten')).toBeVisible();

  // Lightbox aus dem Raster, dann Sprung zur Nachricht.
  await annaSeite.getByRole('tab', { name: 'Medien' }).click();
  await annaSeite.getByRole('button', { name: /^Foto vom .* öffnen$/ }).click();
  await expect(annaSeite.locator('.media-lightbox img').first()).toBeVisible();
  await annaSeite.keyboard.press('Escape');
  await annaSeite.getByRole('button', { name: 'Zur Nachricht springen' }).first().click();
  // Blätter zu, der Chat steht da, die Nachricht im Blick (`?m=` nimmt der
  // Chat nach dem Sprung gleich wieder aus der Adresse).
  await expect(annaSeite.getByRole('tab', { name: 'Medien' })).toHaveCount(0);
  await expect(annaSeite.locator('.media-image').first()).toBeInViewport();

  // Export: Adresse holen und laden – ein ZIP mit chat.txt.
  await annaSeite.getByRole('button', { name: 'Chat-Info öffnen' }).click();
  await annaSeite.getByRole('button', { name: /Chat exportieren/ }).click();
  const [download] = await Promise.all([
    annaSeite.waitForEvent('download'),
    annaSeite.getByRole('button', { name: 'Exportieren' }).click(),
  ]);
  const pfad = await download.path();
  expect(pfad).toBeTruthy();
  const { readFileSync } = await import('node:fs');
  const zip = readFileSync(pfad!);
  expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(zip.includes(Buffer.from('chat.txt'))).toBe(true);
  expect(zip.includes(Buffer.from('Hier der Plan: https://example.org/plan'))).toBe(true);
});

test('Sprachnachricht: gedrückt halten, spielt nach dem Chatwechsel weiter', async ({
  browser,
}) => {
  test.skip(!(await medienGeraeteDa(browser)), OHNE_GERAETE);
  const anna = konto('sara');
  const bodo = konto('sven');
  const annaSeite = await registrieren(browser, anna);
  const bodoSeite = await registrieren(browser, bodo);
  await direktchat(annaSeite, bodo);
  await senden(annaSeite, 'Gleich kommt eine Sprachnachricht');

  // Gedrückt halten (Maus), drei Sekunden, loslassen → gesendet.
  const mikro = annaSeite.getByRole('button', { name: /Sprachnachricht – gedrückt halten/ });
  const box = (await mikro.boundingBox())!;
  await annaSeite.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await annaSeite.mouse.down();
  await expect(annaSeite.getByText('‹ Zum Abbrechen wischen')).toBeVisible({ timeout: 10_000 });
  await annaSeite.waitForTimeout(3000);
  await annaSeite.mouse.up();
  await expect(annaSeite.locator('.media-bubble-audio')).toHaveCount(1, { timeout: 30_000 });

  // Wischen nach links bricht ab – es kommt keine zweite.
  await annaSeite.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await annaSeite.mouse.down();
  await expect(annaSeite.getByText('‹ Zum Abbrechen wischen')).toBeVisible({ timeout: 10_000 });
  await annaSeite.waitForTimeout(800);
  await annaSeite.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 8 });
  await annaSeite.mouse.up();
  await annaSeite.waitForTimeout(1000);
  await expect(annaSeite.locator('.media-bubble-audio')).toHaveCount(1);

  // Bodo hört sie an und verlässt den Chat: Der Spieler läuft weiter.
  await chatOeffnen(bodoSeite, anna.displayName);
  await bodoSeite.locator('.media-bubble-audio').getByRole('button', { name: 'Abspielen' }).click();
  const leiste = bodoSeite.getByRole('region', { name: 'Sprachnachricht' });
  await expect(leiste).toBeVisible();
  await expect(leiste.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 10_000 });
  await bodoSeite.getByRole('button', { name: 'Zurück zu den Chats' }).click();
  await expect(bodoSeite.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(leiste).toBeVisible();
  await expect(leiste).toContainText(anna.displayName);
  const vorher = await bodoSeite.evaluate(
    () => Array.from(document.querySelectorAll('audio')).length,
  );
  expect(vorher).toBe(0); // gespielt wird ausserhalb des Baums
  // Geschwindigkeit wechseln und schliessen.
  await leiste.getByRole('button', { name: /Geschwindigkeit 1-fach/ }).click();
  await expect(leiste.getByRole('button', { name: /Geschwindigkeit 1.5-fach/ })).toBeVisible();
  await leiste.getByRole('button', { name: 'Spieler schliessen' }).click();
  await expect(leiste).toHaveCount(0);
});

test('Videonachricht im Kreis aufnehmen und senden', async ({ browser }) => {
  test.skip(!(await medienGeraeteDa(browser)), OHNE_GERAETE);
  const anna = konto('vera');
  const bodo = konto('vito');
  const annaSeite = await registrieren(browser, anna);
  const bodoSeite = await registrieren(browser, bodo);
  await direktchat(annaSeite, bodo);
  await senden(annaSeite, 'Achtung, Video');

  await annaSeite.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await annaSeite.getByText('Videonachricht').click();
  const dialog = annaSeite.getByRole('dialog', { name: 'Videonachricht aufnehmen' });
  await expect(dialog.getByText(/Bereit/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Aufnahme starten' }).click();
  await annaSeite.waitForTimeout(1200);
  // Kamera wechseln mitten in der Aufnahme – die Aufnahme läuft weiter.
  await dialog.getByRole('button', { name: 'Kamera wechseln' }).click();
  await annaSeite.waitForTimeout(1200);
  await dialog.getByRole('button', { name: 'Aufnahme beenden' }).click();
  await expect(dialog.getByText(/Videonachricht · 00:0\d/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Senden' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(annaSeite.locator('.vn-blase')).toHaveCount(1, { timeout: 30_000 });

  await chatOeffnen(bodoSeite, anna.displayName);
  const kreis = bodoSeite.getByRole('button', { name: /^Videonachricht, / });
  await expect(kreis).toBeVisible({ timeout: 30_000 });
  await kreis.click();
  await expect(kreis).toHaveAttribute('aria-pressed', 'true');
  await expect(bodoSeite.locator('.vn-blase .vn-ring-lauf')).toBeVisible();
});
