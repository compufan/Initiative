import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Das Rezept: die Bearbeitung als Anweisung statt als Kopie.
 *
 * Was hier geprüft wird, ist die Kette über ALLE Schichten – Editor,
 * Hochladen, Nachrichtentyp, Blase, Rückweg in den Editor. Jeder einzelne
 * Schritt hat seine eigene Prüfung (`rezept.test.ts` für das Format,
 * `ton.spec.ts` für die Rechnung), aber keine davon merkt, wenn zwischen
 * zwei Schichten etwas verlorengeht: ein Anhang, der nicht mitreist, ein Typ,
 * den der Server ablehnt, eine Blase, die das Original zeigt statt des
 * Ergebnisses.
 *
 * Und zwei Dinge, die NUR hier auffallen können:
 *
 *   * Das Bild in der Blase muss anders aussehen als das Original – sonst
 *     wurde das Rezept nicht angewandt und niemand merkt es.
 *   * Der Knopf darf nicht erscheinen, wenn die Bearbeitung Bildinhalt
 *     entfernt. Diese Regel steht in `rezept.ts`; dass der Editor sie auch
 *     BEFOLGT, steht nur hier.
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
 * Ein mittelgraues PNG, 320 × 240.
 *
 * Mittelgrau und nicht gesättigt: Unter „Belichtung“ ändert sich ein Grau
 * messbar, ein reines Rot dagegen kaum – der rote Kanal steht schon am
 * Anschlag. Und gross genug, dass die Blase ein sichtbares Bild bekommt.
 */
function grauesPng(breite: number, hoehe: number, wert = 110): Buffer {
  const roh = Buffer.alloc((breite * 3 + 1) * hoehe);
  let at = 0;
  for (let y = 0; y < hoehe; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < breite; x += 1) {
      roh[at] = wert;
      roh[at + 1] = wert;
      roh[at + 2] = wert;
      at += 3;
    }
  }
  const bloecke: Buffer[] = [];
  const block = (typ: string, daten: Buffer) => {
    const kopf = Buffer.alloc(8);
    kopf.writeUInt32BE(daten.length, 0);
    kopf.write(typ, 4, 'ascii');
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(crc32(Buffer.concat([Buffer.from(typ, 'ascii'), daten])) >>> 0, 0);
    bloecke.push(kopf, daten, pruef);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(hoehe, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  block('IHDR', ihdr);
  block('IDAT', deflateSync(roh));
  block('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...bloecke]);
}

async function chatMit(page: Page, gegenueber: string) {
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(gegenueber.split(' ')[0]);
  await page.getByText(gegenueber).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

/**
 * Nach einem Neuladen wieder im Chat stehen.
 *
 * Die App merkt sich, wo sie war: Nach `reload` kann der Chat schon offen
 * sein oder die Liste stehen. Beides ist richtig, und der Test soll nicht an
 * der einen oder anderen Wahl hängen.
 */
async function wiederImChat(page: Page, gegenueber: string) {
  const schreiben = page.getByPlaceholder('Nachricht schreiben');
  const liste = page.getByText(gegenueber).first();
  await expect
    .poll(async () => (await schreiben.count()) + (await liste.count()), { timeout: 30_000 })
    .toBeGreaterThan(0);
  if ((await schreiben.count()) === 0) await liste.click();
  await expect(schreiben).toBeVisible({ timeout: 30_000 });
}

/** Die mittlere Helligkeit eines angezeigten Bildes, so wie es auf dem Schirm steht. */
async function helligkeit(page: Page, waehler: string): Promise<number> {
  return await page
    .locator(waehler)
    .first()
    .evaluate((el: HTMLImageElement) => {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return -1;
      ctx.drawImage(el, 0, 0, 32, 32);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      let summe = 0;
      for (let i = 0; i < 32 * 32; i += 1) summe += d[i * 4];
      return summe / (32 * 32);
    });
}

test('eine Bearbeitung reist als Rezept und kommt beim Empfänger gerechnet an', async ({
  browser,
}) => {
  const alice = credentials('rez');
  const bob = credentials('rezempf');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  await chatMit(alicePage, bob.displayName);

  // Ein Bild aussuchen und VOR dem Senden bearbeiten – der Weg, auf dem das
  // Rezept überhaupt erst entsteht.
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau.png',
    mimeType: 'image/png',
    buffer: grauesPng(320, 240),
  });
  await alicePage.locator('.media-tile-knopf').first().click();

  const leinwand = alicePage.locator('.bild-leinwand');
  await expect(leinwand).toBeVisible({ timeout: 30_000 });

  // Ohne Bearbeitung gibt es kein Rezept – es gäbe ja nichts zu beschreiben.
  await expect(alicePage.getByRole('button', { name: /Als Rezept/ })).toHaveCount(0);

  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = alicePage.getByLabel('Belichtung').first();
  await belichtung.fill('2');
  await belichtung.dispatchEvent('change');

  const knopf = alicePage.getByRole('button', { name: /Als Rezept/ });
  await expect(knopf).toBeVisible({ timeout: 15_000 });
  await knopf.click();

  // Beim Empfänger: die Blase mit dem gerechneten Bild und der zweiten Blase.
  await bobPage.getByText(alice.displayName).first().click();
  const leiste = bobPage.locator('.rezept-leiste');
  await expect(leiste).toBeVisible({ timeout: 30_000 });
  await expect(leiste.getByText('Bearbeitung liegt bei')).toBeVisible();

  const umschalter = leiste.getByRole('button', { name: 'Original' });
  await expect(umschalter).toBeVisible({ timeout: 30_000 });

  /*
   * Der eigentliche Beweis: hell gegen dunkel.
   *
   * Das Original ist überall 110. Mit „Belichtung +2“ steht das Ergebnis
   * deutlich darüber. Wäre das Rezept nicht angewandt worden – weil der
   * Anhang fehlt, weil `rezeptLesen` null gibt, weil die Blase das falsche
   * Bild zeigt –, stünden hier zwei gleiche Zahlen, und genau das ist der
   * Fehler, den keine andere Prüfung sieht.
   */
  const bearbeitet = await helligkeit(bobPage, '.media-image');
  await umschalter.click();
  await expect(leiste.getByRole('button', { name: 'Bearbeitet' })).toBeVisible();
  await bobPage.waitForTimeout(500);
  const original = await helligkeit(bobPage, '.media-image');

  expect(original).toBeGreaterThan(90);
  expect(original).toBeLessThan(130);
  expect(bearbeitet).toBeGreaterThan(original + 40);

  // Und der Rückweg: das Original geht in den Editor, mit der Bearbeitung
  // schon darin.
  await leiste.getByRole('button', { name: /Weiter/ }).click();
  await expect(bobPage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await bobPage.getByRole('button', { name: /Ton$/ }).click();
  await expect(bobPage.getByLabel('Belichtung').first()).toHaveValue(/^2/);

  await alicePage.context().close();
  await bobPage.context().close();
});

test('was Bildinhalt entfernt, wird nicht zum Rezept', async ({ browser }) => {
  /*
   * Die Regel, um derentwillen es `rezeptHindernis` gibt: Beim Rezept reist
   * das Original mit. Wer etwas wegschneidet oder verpixelt, tut das, damit
   * es fort ist – ein Rezept gäbe dem Empfänger einen Knopf, es zurückzuholen.
   *
   * Geprüft wird nicht die Funktion (das tut `rezept.test.ts`), sondern dass
   * der EDITOR sich daran hält und den Knopf wegnimmt, statt ihn anzubieten
   * und beim Tippen zu meckern.
   */
  const alice = credentials('rezsp');
  const bob = credentials('rezspempf');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await chatMit(alicePage, bob.displayName);
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau.png',
    mimeType: 'image/png',
    buffer: grauesPng(320, 240),
  });
  await alicePage.locator('.media-tile-knopf').first().click();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });

  // Erst eine reine Tonbearbeitung: Der Knopf ist da.
  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = alicePage.getByLabel('Belichtung').first();
  await belichtung.fill('1.5');
  await belichtung.dispatchEvent('change');
  await expect(alicePage.getByRole('button', { name: /Als Rezept/ })).toBeVisible({
    timeout: 15_000,
  });

  // Dann ein Strich darüber – und er ist fort, mit Begründung.
  await alicePage.getByRole('button', { name: /Malen$/ }).click();
  const leinwand = alicePage.locator('.bild-leinwand');
  const kasten = await leinwand.boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await alicePage.mouse.move(kasten.x + kasten.width * 0.3, kasten.y + kasten.height * 0.5);
  await alicePage.mouse.down();
  await alicePage.mouse.move(kasten.x + kasten.width * 0.7, kasten.y + kasten.height * 0.5, {
    steps: 8,
  });
  await alicePage.mouse.up();

  await expect(alicePage.getByRole('button', { name: /Als Rezept/ })).toHaveCount(0);
  await expect(alicePage.getByText(/Kein Rezept möglich/)).toBeVisible();

  await alicePage.context().close();
});

test('ein Entwurf überlebt das Schliessen – und den ganzen Browser', async ({ browser }) => {
  /*
   * Die Frage beim Schliessen hilft gegen den falschen Fingertipp. Sie hilft
   * nicht gegen den abgestürzten Browser, den geschlossenen Tab oder ein
   * Telefon, das die Seite aus dem Speicher wirft.
   *
   * Deshalb wird hier NEU GELADEN, statt nur den Editor zu schliessen: Das
   * ist die Lage, in der die Arbeit bisher ohne jede Rückfrage verschwand.
   * Ein Entwurf, der nur ein Schliessen überlebt, könnte auch im
   * Arbeitsspeicher stehen – und stünde beim nächsten Mal nicht mehr da.
   */
  const alice = credentials('entw');
  const bob = credentials('entwempf');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await chatMit(alicePage, bob.displayName);
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau.png',
    mimeType: 'image/png',
    buffer: grauesPng(320, 240),
  });
  await alicePage.locator('.media-tile-knopf').first().click();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });

  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = alicePage.getByLabel('Belichtung').first();
  await belichtung.fill('1.75');
  await belichtung.dispatchEvent('change');
  // Der Entwurf wird nach einer Dreiviertelsekunde Ruhe geschrieben.
  await alicePage.waitForTimeout(1500);

  // Und jetzt ist der Browser weg. Kein Schliessen, kein Verwerfen, nichts.
  await alicePage.reload();
  await wiederImChat(alicePage, bob.displayName);
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau.png',
    mimeType: 'image/png',
    buffer: grauesPng(320, 240),
  });
  await alicePage.locator('.media-tile-knopf').first().click();

  // Gefragt wird, nicht angewandt.
  await expect(alicePage.getByText('Entwurf weiterführen?')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByRole('button', { name: 'Weiterführen' }).click();

  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  await expect(alicePage.getByLabel('Belichtung').first()).toHaveValue(/^1\.75/);

  await alicePage.context().close();
});

test('„Neu anfangen" lässt den Entwurf nicht wiederkommen', async ({ browser }) => {
  /*
   * Wer „Neu anfangen" sagt, hat entschieden. Bliebe der Entwurf liegen,
   * käme dieselbe Frage beim nächsten Aufmachen wieder – und das ist genau
   * die Sorte Beharrlichkeit, die man einem Werkzeug übelnimmt.
   */
  const alice = credentials('entwneu');
  const bob = credentials('entwneuempf');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await chatMit(alicePage, bob.displayName);

  const aufmachen = async () => {
    await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
    await alicePage.getByText('Foto/Video').click();
    await alicePage.locator('input[type=file]').setInputFiles({
      name: 'grau.png',
      mimeType: 'image/png',
      buffer: grauesPng(320, 240),
    });
    await alicePage.locator('.media-tile-knopf').first().click();
  };

  await aufmachen();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = alicePage.getByLabel('Belichtung').first();
  await belichtung.fill('1.75');
  await belichtung.dispatchEvent('change');
  await alicePage.waitForTimeout(1500);
  await alicePage.reload();
  await wiederImChat(alicePage, bob.displayName);

  await aufmachen();
  await expect(alicePage.getByText('Entwurf weiterführen?')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByRole('button', { name: 'Neu anfangen' }).click();
  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  await expect(alicePage.getByLabel('Belichtung').first()).toHaveValue(/^0/);

  /*
   * Schliessen und noch einmal aufmachen – die Frage darf nicht wiederkommen.
   *
   * Das Auswahlblatt steht dahinter noch offen (es ist nur beiseitegetreten),
   * also geht es hier direkt über den Stift an der Kachel und nicht noch
   * einmal über „Mehr hinzufügen".
   */
  await alicePage.getByRole('button', { name: 'Schließen' }).first().click();
  await alicePage.locator('.media-tile-knopf').first().click();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await alicePage.waitForTimeout(1000);
  await expect(alicePage.getByText('Entwurf weiterführen?')).toHaveCount(0);

  await alicePage.context().close();
});
