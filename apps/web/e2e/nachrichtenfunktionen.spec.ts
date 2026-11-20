import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Lesehäkchen, Weiterleiten, Reaktionen mit Auswahl, Formatierung, Suche mit
 * Sprung und Entwürfe über zwei Geräte – jeweils mit zwei (oder drei)
 * Browsern gegen den echten Server.
 */

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
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(wer.username);
  await page.getByLabel('Anzeigename').fill(wer.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(wer.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return page;
}

async function anmelden(browser: Browser, wer: Konto): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel('Benutzername').fill(wer.username);
  await page.getByLabel('Passwort', { exact: true }).fill(wer.password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('link', { name: /Chats/ }).first()).toBeVisible();
  await page.goto('/chats');
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

/** Die Zeile einer Nachricht mit diesem Text. */
function zeile(page: Page, text: string | RegExp) {
  return page.locator('.msg-row').filter({ hasText: text }).last();
}

test('Häkchen grau → blau, Formatierung, Reaktion aus der Auswahl', async ({ browser }) => {
  const anna = konto('anna');
  const bodo = konto('bodo');
  const annaSeite = await registrieren(browser, anna);
  const bodoSeite = await registrieren(browser, bodo);

  await direktchat(annaSeite, bodo);
  await senden(annaSeite, 'Treffen *heute* um _acht_ – ||Überraschung||');

  // Formatierung: fett und kursiv als Elemente, der Spoiler verdeckt.
  const blase = zeile(annaSeite, 'Treffen');
  await expect(blase.locator('strong', { hasText: 'heute' })).toBeVisible();
  await expect(blase.locator('em', { hasText: 'acht' })).toBeVisible();
  const spoiler = blase.getByRole('button', { name: /Spoiler/ });
  await expect(spoiler).toBeVisible();
  await expect(blase).not.toContainText('*heute*');
  await spoiler.click();
  await expect(blase.locator('.msg-spoiler-offen')).toHaveText('Überraschung');

  // Bodo hat die App offen (Chatliste): Die Nachricht kommt an → zugestellt.
  await expect(bodoSeite.getByText(anna.displayName).first()).toBeVisible({ timeout: 15_000 });
  // Die Vorschau in der Liste ohne Marken, der Spoiler verdeckt.
  await expect(bodoSeite.getByText(/Treffen heute um acht – ▒▒▒/).first()).toBeVisible();
  const haken = blase.locator('.msg-haken');
  await expect(haken).toHaveAttribute('data-haken', 'zugestellt', { timeout: 15_000 });
  await expect(haken).not.toHaveClass(/msg-haken-gelesen/);
  const grau = await haken.evaluate((el) => getComputedStyle(el).color);

  // Bodo öffnet den Chat → gelesen, blau.
  await bodoSeite.getByText(anna.displayName).first().click();
  await expect(haken).toHaveAttribute('data-haken', 'gelesen', { timeout: 15_000 });
  await expect(haken).toHaveClass(/msg-haken-gelesen/);
  const blau = await haken.evaluate((el) => getComputedStyle(el).color);
  expect(blau).not.toBe(grau);
  await expect(haken).toHaveAttribute('aria-label', 'gelesen');

  // Nachrichteninfo: Bodo unter „Gelesen von“, mit Zeit.
  await blase.getByRole('button', { name: 'Nachrichtenoptionen' }).click();
  await annaSeite.getByRole('button', { name: /Info \(gelesen/ }).click();
  const info = annaSeite.getByRole('region', { name: 'Gelesen von' });
  await expect(info).toContainText(bodo.displayName);
  await expect(info).toContainText(/heute \d\d:\d\d/);
  await annaSeite.keyboard.press('Escape');

  // Bodo reagiert über „＋“ mit der Suche der Emoji-Auswahl.
  const bodoBlase = zeile(bodoSeite, 'Treffen');
  await bodoBlase.getByRole('button', { name: 'Nachrichtenoptionen' }).click();
  await bodoSeite.getByRole('button', { name: 'Weitere Emoji' }).click();
  await bodoSeite.getByLabel('Emoji suchen').fill('einhorn');
  await bodoSeite.getByRole('button', { name: 'einhorn' }).click();
  await expect(zeile(annaSeite, 'Treffen').locator('.msg-reaction', { hasText: '🦄' })).toBeVisible(
    { timeout: 15_000 },
  );

  // „Wer hat reagiert?“ – und die eigene Reaktion dort entfernen.
  await bodoBlase.getByRole('button', { name: 'Wer hat reagiert?' }).click();
  await expect(bodoSeite.getByRole('dialog')).toContainText('Du');
  await bodoSeite.getByRole('button', { name: /Deine Reaktion 🦄 entfernen/ }).click();
  await expect(zeile(annaSeite, 'Treffen').locator('.msg-reaction', { hasText: '🦄' })).toHaveCount(
    0,
    { timeout: 15_000 },
  );

  await annaSeite.context().close();
  await bodoSeite.context().close();
});

test('weiterleiten mit Herkunft an einen anderen Chat', async ({ browser }) => {
  const anna = konto('anna');
  const bodo = konto('bodo');
  const cleo = konto('cleo');
  const annaSeite = await registrieren(browser, anna);
  const bodoSeite = await registrieren(browser, bodo);
  const cleoSeite = await registrieren(browser, cleo);

  await direktchat(bodoSeite, cleo);
  await senden(bodoSeite, 'Hallo Cleo');
  await bodoSeite.goto('/chats');

  await direktchat(annaSeite, bodo);
  const text = `Weiterzusagen ${Date.now()}`;
  await senden(annaSeite, text);

  await bodoSeite.getByText(anna.displayName).first().click();
  const blase = zeile(bodoSeite, text);
  await blase.getByRole('button', { name: 'Nachrichtenoptionen' }).click();
  await bodoSeite.getByRole('button', { name: 'Weiterleiten' }).click();
  await bodoSeite.getByRole('searchbox', { name: 'Chat suchen' }).fill(cleo.displayName.slice(0, 6));
  await bodoSeite.getByRole('checkbox', { name: cleo.displayName }).check();
  await bodoSeite.getByRole('button', { name: 'Weiterleiten an 1' }).click();

  await cleoSeite.getByText(bodo.displayName).first().click();
  const kopie = zeile(cleoSeite, text);
  await expect(kopie).toBeVisible({ timeout: 15_000 });
  await expect(kopie).toContainText(`Weitergeleitet von ${anna.displayName}`);

  for (const seite of [annaSeite, bodoSeite, cleoSeite]) await seite.context().close();
});

test('Suche im Chat springt zu einem älteren, noch nicht geladenen Treffer', async ({
  browser,
}) => {
  const anna = konto('anna');
  const bodo = konto('bodo');
  let annaSeite = await registrieren(browser, anna);
  await registrieren(browser, bodo);

  await direktchat(annaSeite, bodo);
  await senden(annaSeite, 'Die Nadel im Heuhaufen');
  const feld = annaSeite.getByPlaceholder('Nachricht schreiben');
  // Mehr als eine Seite (50), damit die Nadel beim Öffnen nicht geladen ist.
  for (let i = 0; i < 56; i += 1) {
    await feld.fill(`Heu ${i}`);
    await feld.press('Enter');
  }
  await expect(zeile(annaSeite, 'Heu 55')).toBeVisible();
  await expect(annaSeite.getByLabel('wird gesendet')).toHaveCount(0, { timeout: 30_000 });

  // Ein frisches Gerät: Nur die neueste Seite kommt vom Server, die Nadel
  // liegt davor (auf dem ersten Gerät stünde sie schon im Zwischenspeicher).
  await annaSeite.context().close();
  annaSeite = await anmelden(browser, anna);
  await annaSeite.getByText(bodo.displayName).first().click();
  await expect(zeile(annaSeite, 'Heu 55')).toBeVisible();
  await expect(annaSeite.getByText('Die Nadel im Heuhaufen')).toHaveCount(0);

  await annaSeite.getByRole('button', { name: 'Im Chat suchen' }).click();
  await annaSeite.getByLabel('Suchbegriff').fill('Nadel');
  await expect(annaSeite.getByText('1 von 1')).toBeVisible({ timeout: 15_000 });
  const treffer = zeile(annaSeite, 'Heuhaufen');
  await expect(treffer).toBeInViewport({ timeout: 15_000 });
  await expect(treffer.locator('mark.msg-treffer')).toHaveText('Nadel');

  // Filter: Links – keine.
  await annaSeite.getByRole('button', { name: 'Links', exact: true }).click();
  await expect(annaSeite.getByText('Keine Treffer')).toBeVisible();

  // Globale Suche in der Chatliste: Der Treffer öffnet den Chat AN der Stelle.
  await annaSeite.goto('/chats');
  await annaSeite.getByRole('button', { name: 'Chats durchsuchen' }).click();
  await annaSeite.getByRole('searchbox').first().fill('Heuhaufen');
  await annaSeite.getByRole('button', { name: /Heuhaufen/ }).first().click();
  await expect(zeile(annaSeite, 'Heuhaufen')).toBeInViewport({ timeout: 15_000 });

  await annaSeite.context().close();
});

test('Entwurf geht auf das andere Gerät und verschwindet nach dem Senden', async ({
  browser,
}) => {
  const anna = konto('anna');
  const bodo = konto('bodo');
  const geraetA = await registrieren(browser, anna);
  await registrieren(browser, bodo);

  await direktchat(geraetA, bodo);
  await senden(geraetA, 'Erste Nachricht');
  const geraetB = await anmelden(browser, anna);

  await geraetA.getByPlaceholder('Nachricht schreiben').fill('Halb fertiger Gedanke');
  // Gerät B (Chatliste offen) bekommt den Entwurf über den Server.
  await expect(geraetB.getByText('Entwurf: Halb fertiger Gedanke')).toBeVisible({
    timeout: 15_000,
  });

  // Auf Gerät B öffnen: der Entwurf steht in der Eingabezeile.
  await geraetB.getByText(bodo.displayName).first().click();
  const feldB = geraetB.getByPlaceholder('Nachricht schreiben');
  await expect(feldB).toHaveValue('Halb fertiger Gedanke');
  await feldB.fill('Halb fertiger Gedanke – jetzt fertig');
  await geraetB.getByRole('button', { name: 'Senden' }).click();

  // Gerät A: Chatliste ohne Entwurf.
  await geraetA.goto('/chats');
  await expect(geraetA.getByText(/jetzt fertig/).first()).toBeVisible({ timeout: 15_000 });
  await expect(geraetA.getByText(/^Entwurf:/)).toHaveCount(0, { timeout: 15_000 });

  await geraetA.context().close();
  await geraetB.context().close();
});
