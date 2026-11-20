import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Zweite Welle Nachrichtenfunktionen mit zwei Browsern gegen den echten
 * Server: @Erwähnung mit Autovervollständigung, Bearbeiten mit Verlauf,
 * Anheften, Später senden, Selbstlöschen, Einmal ansehen und Standort
 * (einmalig und live).
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

async function registrieren(browser: Browser, wer: Konto): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['geolocation']);
  await ctx.setGeolocation({ latitude: 47.3769, longitude: 8.5417, accuracy: 12 });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(wer.username);
  await page.getByLabel('Anzeigename').fill(wer.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(wer.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return { page, ctx };
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

function zeile(page: Page, text: string | RegExp) {
  return page.locator('.msg-row').filter({ hasText: text }).last();
}

async function chatOeffnen(page: Page, mit: Konto): Promise<void> {
  await page.goto('/chats');
  await page.getByRole('link', { name: new RegExp(mit.displayName) }).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

async function menue(page: Page, text: string | RegExp): Promise<void> {
  await zeile(page, text).getByRole('button', { name: 'Nachrichtenoptionen' }).click();
}

test('Erwähnung, Bearbeiten mit Verlauf, Anheften, Später senden', async ({ browser }) => {
  const anna = konto('anna');
  const bodo = konto('bodo');
  const a = await registrieren(browser, anna);
  const b = await registrieren(browser, bodo);
  await direktchat(a.page, bodo);
  await senden(a.page, 'Hallo');
  await expect(zeile(a.page, 'Hallo').getByRole('img', { name: /gesendet|zugestellt|gelesen/ })).toBeVisible();

  // @-Autovervollständigung mit der Tastatur.
  const feld = a.page.getByPlaceholder('Nachricht schreiben');
  await feld.fill('Kommst du ');
  await feld.pressSequentially('@BO');
  const liste = a.page.getByRole('listbox', { name: 'Erwähnen' });
  await expect(liste.getByRole('option', { name: new RegExp(bodo.displayName) })).toBeVisible();
  await feld.press('Enter');
  await expect(feld).toHaveValue(`Kommst du @${bodo.displayName} `);
  await feld.pressSequentially('morgen?');
  await a.page.getByRole('button', { name: 'Senden' }).click();
  await expect(zeile(a.page, 'morgen?').locator('.msg-erwaehnung')).toHaveText(`@${bodo.displayName}`);

  // Bodo: „@“ in der Chatliste, im Chat die eigene Erwähnung hervorgehoben.
  await expect(b.page.getByRole('img', { name: 'Du wurdest erwähnt' })).toBeVisible();
  await chatOeffnen(b.page, anna);
  await expect(zeile(b.page, 'morgen?').locator('.msg-erwaehnung-ich')).toHaveText(`@${bodo.displayName}`);

  // Bearbeiten: Anna ändert, Bodo sieht den Verlauf.
  await menue(a.page, 'morgen?');
  await a.page.getByRole('button', { name: /^Bearbeiten/ }).click();
  const bearbeiten = a.page.getByLabel('Nachricht bearbeiten');
  await bearbeiten.fill(`Kommst du @${bodo.displayName} übermorgen?`);
  await a.page.getByRole('button', { name: 'Änderung speichern' }).click();
  await expect(zeile(b.page, 'übermorgen?')).toBeVisible();
  await zeile(b.page, 'übermorgen?').getByRole('button', { name: /Bearbeitungsverlauf/ }).click();
  const verlauf = b.page.getByRole('dialog', { name: 'Bearbeitungsverlauf' });
  await expect(verlauf.getByText(/morgen\?$/).first()).toBeVisible();
  await expect(verlauf).toContainText('übermorgen?');
  await b.page.keyboard.press('Escape');

  // Anheften (Direktchat: beide dürfen). Banner bei Anna per Echtzeit.
  await menue(b.page, 'übermorgen?');
  await b.page.getByRole('button', { name: 'Anheften' }).click();
  const banner = a.page.getByRole('region', { name: 'Angeheftete Nachrichten' });
  await expect(banner).toContainText('übermorgen?');
  await expect(a.page.locator('.msg-system, .msg-row').filter({ hasText: /angeheftet/i }).first()).toBeVisible();

  // Später senden: langer Druck (Rechtsklick) auf Senden.
  await feld.fill('Geplanter Gruss');
  await a.page.getByRole('button', { name: 'Senden' }).click({ button: 'right' });
  await a.page.getByRole('menuitem', { name: /Später senden/ }).click();
  const planen = a.page.getByRole('dialog', { name: 'Später senden' });
  await planen.getByRole('button', { name: /Planen/ }).click();
  await expect(a.page.getByRole('button', { name: '🕒 1 geplante Nachricht' })).toBeVisible();
  await expect(feld).toHaveValue('');
  await a.page.getByRole('button', { name: '🕒 1 geplante Nachricht' }).click();
  const geplant = a.page.getByRole('dialog', { name: 'Geplante Nachrichten' });
  await expect(geplant).toContainText('Geplanter Gruss');
  await geplant.getByRole('button', { name: 'Jetzt senden' }).click();
  await expect(zeile(b.page, 'Geplanter Gruss')).toBeVisible();
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByRole('button', { name: /geplante Nachricht/ })).toHaveCount(0);

  await a.ctx.close();
  await b.ctx.close();
});

test('Selbstlöschen, Einmal ansehen, Standort einmalig und live', async ({ browser }) => {
  const anna = konto('cleo');
  const bodo = konto('dora');
  const a = await registrieren(browser, anna);
  const b = await registrieren(browser, bodo);
  await direktchat(a.page, bodo);
  await senden(a.page, 'Hallo');
  await chatOeffnen(b.page, anna);
  await expect(zeile(b.page, 'Hallo')).toBeVisible();

  // Selbstlöschen einstellen: Systemzeile, Leiste, Timer an neuen Nachrichten.
  await a.page.getByRole('button', { name: 'Chat-Menü' }).click();
  await a.page.getByRole('button', { name: 'Selbstlöschende Nachrichten' }).click();
  const sheet = a.page.getByRole('dialog', { name: 'Selbstlöschende Nachrichten' });
  await expect(sheet).toContainText('Ende-zu-Ende');
  await sheet.getByLabel('24 Stunden').click();
  await expect(a.page.getByRole('button', { name: /Selbstlöschende Nachrichten: 24 Stunden/ })).toBeVisible();
  await senden(a.page, 'Verschwindet bald');
  await expect(zeile(b.page, 'Verschwindet bald').getByRole('img', { name: /Verschwindet/ })).toBeVisible();

  // Einmal ansehen: Bodo öffnet genau einmal, Anna sieht „Geöffnet“.
  await a.page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await a.page.getByRole('button', { name: /Einmal ansehen/ }).click();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await a.page.getByLabel('Foto oder Video aus der Galerie').setInputFiles({
    name: 'geheim.png',
    mimeType: 'image/png',
    buffer: png,
  });
  const einmal = b.page.getByRole('button', { name: /einmal ansehen/ });
  await expect(einmal).toBeVisible();
  await einmal.click();
  const ansicht = b.page.getByRole('dialog', { name: /Einmal ansehbares Foto/ });
  await expect(ansicht.getByRole('img')).toBeVisible();
  await expect(ansicht).toContainText('Bildschirmfotos');
  await ansicht.getByRole('button', { name: 'Schliessen' }).click();
  await expect(b.page.locator('.msg-einmal').last()).toContainText('Geöffnet');
  await expect(a.page.locator('.msg-einmal').last()).toContainText('Geöffnet');

  // Standort einmalig.
  await a.page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await a.page.getByRole('button', { name: /Standort/ }).click();
  const standort = a.page.getByRole('dialog', { name: 'Standort teilen' });
  await expect(standort).toContainText('47.37690° N');
  await standort.getByRole('button', { name: /Diesen Standort senden/ }).click();
  await expect(b.page.locator('.msg-standort').last()).toContainText('47.37690° N, 8.54170° O');
  await expect(b.page.locator('.msg-standort').last()).toContainText('± 12 m');
  await expect(b.page.locator('.msg-standort').last().getByRole('button', { name: 'In Karten-App öffnen' })).toBeVisible();

  // Live: Bewegung kommt bei Bodo an, Verbergen der App beendet die Freigabe.
  await a.page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await a.page.getByRole('button', { name: /Standort/ }).click();
  await a.page.getByRole('dialog', { name: 'Standort teilen' }).getByRole('button', { name: 'Live 15 min' }).click();
  const live = b.page.locator('.msg-standort').last();
  await expect(live).toContainText('Live · aktualisiert');
  await a.ctx.setGeolocation({ latitude: 47.38, longitude: 8.55, accuracy: 8 });
  await expect(live).toContainText('47.38000° N', { timeout: 20_000 });
  await a.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(live).toContainText('Live beendet');

  await a.ctx.close();
  await b.ctx.close();
});
