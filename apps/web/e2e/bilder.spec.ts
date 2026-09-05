import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Ein einfarbiges PNG beliebiger Grösse, im Test gebaut.
 *
 * Statt fünfzehn Kilobyte Base64 im Quelltext: Ein gleichmässiges Bild
 * komprimiert auf ein Tausendstel, und die Grösse ist hier ein PARAMETER –
 * genau darum geht es bei der Prüfung des Fangbereichs, die ein Bild braucht,
 * das grösser ist als die Arbeitsfläche.
 */
function grauesPng(breite: number, hoehe: number, wert = 90): Buffer {
  return pngAus(breite, hoehe, () => [wert, wert, wert]);
}

/**
 * Ein Bild mit einem erkennbaren Motiv: dunkle Gestalt auf hellem Grund.
 *
 * Für die Netze. Auf einer gleichmässigen Fläche findet U²-Net zu Recht
 * nichts – das prüft den Fehlerweg, nicht den Erfolgsweg.
 */
function motivPng(breite: number, hoehe: number): Buffer {
  const kopfX = breite / 2;
  const kopfY = hoehe * 0.28;
  const kopfR = Math.min(breite, hoehe) * 0.14;
  return pngAus(breite, hoehe, (x, y) => {
    const imKopf = (x - kopfX) ** 2 + (y - kopfY) ** 2 < kopfR ** 2;
    const imRumpf = x > breite * 0.33 && x < breite * 0.67 && y > hoehe * 0.4;
    /*
     * Bewusst UNBUNT: rot gleich blau, überall.
     *
     * Der Maskenschleier wird über seinen Rotstich (r − b) gemessen. Auf
     * einem farbigen Bild trägt schon das Motiv selbst einen Rotstich, und
     * die Messung mischt zwei Dinge. Unbunt heisst: ohne Schleier ist r − b
     * exakt null, mit Schleier deutlich positiv – ein Signal, das nichts
     * verwässert.
     */
    if (imKopf || imRumpf) return [50, 50, 50];
    // Ein sanfter Verlauf statt einer Fläche: Ein völlig gleichmässiges Bild
    // sieht ein Netz als ebenso motivlos an wie gar keines.
    const wert = Math.round(168 + 60 * (y / hoehe));
    return [wert, wert, wert];
  });
}

function pngAus(
  breite: number,
  hoehe: number,
  farbe: (x: number, y: number) => [number, number, number],
): Buffer {
  const zeilen: Buffer[] = [];
  for (let y = 0; y < hoehe; y += 1) {
    // Jede PNG-Zeile beginnt mit dem Filterbyte 0 („kein Filter“).
    const zeile = Buffer.alloc(breite * 3 + 1);
    for (let x = 0; x < breite; x += 1) {
      const [r, g, b] = farbe(x, y);
      zeile[1 + x * 3] = r;
      zeile[2 + x * 3] = g;
      zeile[3 + x * 3] = b;
    }
    zeilen.push(zeile);
  }
  const stueck = (typ: string, daten: Buffer): Buffer => {
    const inhalt = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(daten.length);
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(crc32(inhalt) >>> 0);
    return Buffer.concat([laenge, inhalt, pruef]);
  };
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(breite, 0);
  kopf.writeUInt32BE(hoehe, 4);
  kopf[8] = 8; // acht Bit je Kanal
  kopf[9] = 2; // Farbtyp 2: RGB ohne Alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    stueck('IHDR', kopf),
    stueck('IDAT', deflateSync(Buffer.concat(zeilen), { level: 9 })),
    stueck('IEND', Buffer.alloc(0)),
  ]);
}

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

/**
 * Dasselbe Grau, aber 320 × 240.
 *
 * Für alles, wo etwas AUF dem Bild sichtbar sein muss: Die Schriftgrösse
 * leitet sich aus der Bildkante ab (`max(sicht)/12`), und auf einem
 * 8 × 8-Bild wäre ein Schriftzug 0,67 Punkte hoch – im Bild nicht zu finden
 * und im Test nicht zu messen.
 */
const GRAU_GROSS_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACCklEQVR42u3TQQkAAAwDseqsfyH1sN8gkXBwKfBW' +
    'JAADAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCA' +
    'gcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBg' +
    'YMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwY' +
    'GDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwG' +
    'BgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OB' +
    'AQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICB' +
    'wcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBg' +
    'wMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBi4G517eoUEiFhwAAAAAElFTkSuQmCC',
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

test('im Ton-Reiter versetzt ein Tipp auf die Leinwand keinen Schriftzug', async ({ browser }) => {
  /*
   * Ein Fehler, den ich mit dem Ton-Reiter selbst eingebaut habe.
   *
   * `onPointerDown` hatte einen Zweig für „Zuschnitt“ und einen für „Malen“ –
   * und liess ALLES ÜBRIGE in den Textzweig fallen. Mit dem neuen Reiter
   * hiess das: Wer auf die Leinwand tippt, um zu sehen, was seine Belichtung
   * macht, versetzt nebenbei den zuletzt gewählten Schriftzug quer durchs
   * Bild. Beim Loslassen, ohne jede Rückmeldung.
   *
   * Der Riegel steht jetzt ausdrücklich da (`werkzeug !== 'text'`), damit es
   * mit dem nächsten Werkzeug nicht wieder passiert.
   */
  const alice = credentials('riegel');
  const bob = credentials('riegelb');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau-gross.png',
    mimeType: 'image/png',
    buffer: GRAU_GROSS_PNG,
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  const leinwand = alicePage.locator('.bild-leinwand');
  await expect(leinwand).toBeVisible({ timeout: 30_000 });

  // Einen Schriftzug anlegen – er landet in der Bildmitte und ist gewählt.
  await alicePage.getByRole('button', { name: /Text$/ }).click();
  await alicePage.getByRole('button', { name: '＋ Schriftzug' }).click();
  await expect(alicePage.locator('.bild-textfeld')).toBeVisible();

  /** Wo der Schriftzug im Dokument steht – aus dem Bild gelesen. */
  const schriftOrt = async () =>
    leinwand.evaluate((el) => {
      // Der Schriftzug ist weiss mit dunkler Kontur auf grauem Grund. Der
      // Schwerpunkt der hellsten Punkte sagt, wo er sitzt.
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      const d = ctx?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return null;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
          const p = i / 4;
          sx += p % c.width;
          sy += Math.floor(p / c.width);
          n += 1;
        }
      }
      return n > 20 ? { x: sx / n / c.width, y: sy / n / c.height, n } : null;
    });

  const vorher = await schriftOrt();
  expect(vorher, 'der Schriftzug ist nicht zu finden').not.toBeNull();

  // In den Ton-Reiter und deutlich neben die Mitte tippen.
  await alicePage.getByRole('button', { name: /Ton$/ }).click();
  const kasten = await leinwand.boundingBox();
  expect(kasten).not.toBeNull();
  await alicePage.mouse.click(kasten!.x + kasten!.width * 0.2, kasten!.y + kasten!.height * 0.8);

  const nachher = await schriftOrt();
  expect(nachher).not.toBeNull();
  expect(Math.abs(nachher!.x - vorher!.x)).toBeLessThan(0.02);
  expect(Math.abs(nachher!.y - vorher!.y)).toBeLessThan(0.02);
  // Und es ist auch kein Rückgängig-Schritt entstanden.
  await expect(alicePage.getByRole('button', { name: 'Rückgängig' })).toBeEnabled();

  await alicePage.context().close();
});

test('ein Verlaufsbereich dunkelt nur die obere Bildhaelfte ab', async ({ browser }) => {
  /*
   * Stufe 4 von der Bedienseite: Kommt eine örtliche Anpassung vom Knopf bis
   * auf die Leinwand, und wirkt sie NUR dort, wo ihre Maske greift?
   *
   * Das ist der ganze Unterschied zur globalen Anpassung, und er lässt sich
   * nur am Bild messen: obere Hälfte dunkler, untere unverändert.
   */
  const alice = credentials('bereich');
  const bob = credentials('bziel');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'grau-gross.png',
    mimeType: 'image/png',
    buffer: GRAU_GROSS_PNG,
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  const leinwand = alicePage.locator('.bild-leinwand');
  await expect(leinwand).toBeVisible({ timeout: 30_000 });

  /** Die mittlere Helligkeit eines waagerechten Streifens der Leinwand. */
  const streifen = async (vonAnteil: number, bisAnteil: number) =>
    alicePage.evaluate(
      ({ von, bis }) => {
        const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
        const ctx = c?.getContext('2d');
        const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
        if (!c || !d) return -1;
        let summe = 0;
        let n = 0;
        for (let y = Math.round(c.height * von); y < Math.round(c.height * bis); y += 1)
          for (let x = 0; x < c.width; x += 1) {
            summe += d[(y * c.width + x) * 4];
            n += 1;
          }
        return n > 0 ? summe / n : -1;
      },
      { von: vonAnteil, bis: bisAnteil },
    );

  await alicePage.getByRole('button', { name: /Bereiche$/ }).click();
  // Ohne Bereich sagt der Reiter, wozu er da ist.
  await expect(alicePage.getByText(/Ein Bereich ist eine Anpassung/)).toBeVisible();

  await alicePage.getByRole('button', { name: '↗ Verlauf' }).click();
  await expect(alicePage.getByRole('button', { name: '👁 Maske zeigen' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  /*
   * Der Schleier zeigt, WO die Maske greift – und zwar rot. Ohne ihn zöge man
   * an unsichtbaren Griffen. Gemessen wird die Rotverschiebung: Auf grauem
   * Grund ist Rot minus Grün null, unter dem Schleier deutlich positiv.
   */
  const rotstich = async (vonAnteil: number, bisAnteil: number) =>
    alicePage.evaluate(
      ({ von, bis }) => {
        const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
        const ctx = c?.getContext('2d');
        const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
        if (!c || !d) return -1;
        let summe = 0;
        let n = 0;
        for (let y = Math.round(c.height * von); y < Math.round(c.height * bis); y += 1)
          for (let x = 0; x < c.width; x += 1) {
            const at = (y * c.width + x) * 4;
            summe += d[at] - d[at + 1];
            n += 1;
          }
        return n > 0 ? summe / n : -1;
      },
      { von: vonAnteil, bis: bisAnteil },
    );
  // Unten greift die Maske ganz, oben gar nicht.
  expect(await rotstich(0.75, 1)).toBeGreaterThan(25);
  expect(await rotstich(0, 0.1)).toBeLessThan(3);

  // Schleier aus, damit die Messung das Bild misst und nicht die Anzeige.
  await alicePage.getByRole('button', { name: '👁 Maske zeigen' }).click();
  const obenVorher = await streifen(0, 0.25);
  const obenEngVorher = await streifen(0, 0.1);
  const untenVorher = await streifen(0.75, 1);
  expect(Math.abs(obenVorher - untenVorher)).toBeLessThan(3);

  /** Der Zeilenmittelwert jeder Leinwandzeile – die Grundlage für die Grenze. */
  const zeilenMittel = async () =>
    alicePage.evaluate(() => {
      const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
      const ctx = c?.getContext('2d');
      const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
      if (!c || !d) return [] as number[];
      const zeilen: number[] = [];
      for (let y = 0; y < c.height; y += 1) {
        let summe = 0;
        for (let x = 0; x < c.width; x += 1) summe += d[(y * c.width + x) * 4];
        zeilen.push(summe / c.width);
      }
      return zeilen;
    });
  const zeilenVorher = await zeilenMittel();

  // Zwei Blenden dunkler – der Verlauf laeuft von 15 % auf 55 % der Hoehe.
  const belichtung = alicePage.locator('.bild-panel').getByRole('slider', { name: /Belichtung/ });
  await belichtung.fill('-2');
  await expect
    .poll(async () => streifen(0.75, 1), { timeout: 5_000 })
    .toBeLessThan(untenVorher - 20);

  const obenNachher = await streifen(0, 0.1);
  const untenNachher = await streifen(0.75, 1);
  expect(Math.abs(obenNachher - obenEngVorher)).toBeLessThan(1);
  expect(untenVorher - untenNachher).toBeGreaterThan(20);

  /*
   * Und jetzt die Eigenschaft, auf die es wirklich ankommt: Ein Verlauf hat
   * eine SCHARFE Grenze. Oberhalb von `von` ist sein Gewicht exakt null, und
   * zwar nicht „fast“ – `weich(0, 1, t)` ist für t ≤ 0 genau 0.
   *
   * Gemessen als Zeilenzahl statt als Helligkeitsunterschied: Wieviele Zeilen
   * von oben sind Byte für Byte dieselben wie vorher? Bei einem Verlauf ab
   * 15 % der Höhe sind das 15 % der Zeilen. Liefe er über die ganze Höhe,
   * wäre KEINE einzige Zeile unverändert – auch wenn der Helligkeits-
   * unterschied dort oben nur 0,36 Stufen von 255 beträgt und in jeder
   * gemittelten Messung untergeht.
   *
   * Genau daran ist meine erste Fassung dieses Tests gescheitert: Sie mass
   * Mittelwerte und liess die Mutation „Verlauf über die ganze Höhe“ durch.
   */
  const unveraenderteZeilen = await alicePage.evaluate((vorher: number[]) => {
    const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
    const ctx = c?.getContext('2d');
    const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
    if (!c || !d) return -1;
    for (let y = 0; y < c.height; y += 1) {
      let summe = 0;
      for (let x = 0; x < c.width; x += 1) summe += d[(y * c.width + x) * 4];
      // Eine Zeile gilt als unverändert, wenn ihr Mittel um weniger als eine
      // halbe Stufe abweicht – das ist die Rundung auf ganze Bytes.
      if (Math.abs(summe / c.width - vorher[y]) > 0.5) return y;
    }
    return c.height;
  }, zeilenVorher);
  const c = await alicePage.evaluate(
    () => (document.querySelector('.bild-leinwand') as HTMLCanvasElement).height,
  );
  expect(unveraenderteZeilen / c).toBeGreaterThan(0.12);
  expect(unveraenderteZeilen / c).toBeLessThan(0.2);

  /*
   * Und jetzt der Griff.
   *
   * Die Achse liegt zwischen `von` (15 %) und `bis` (55 %), ihr Griff also
   * bei 35 % der Höhe in der Mitte. Zieht man ihn nach oben auf 5 %, wandert
   * der ganze Verlauf mit: `bis` liegt dann bei 25 %, und alles darunter –
   * einschliesslich der oberen Messzone – bekommt volles Gewicht.
   *
   * Das ist die eigentliche Prüfung dieser Stufe. Die Ausgangslage eines
   * neuen Verlaufs ist eine Gestaltungsentscheidung; DASS man ihn bewegen
   * kann, ist die Funktion. Ohne diesen Zug zöge man an unsichtbaren Griffen
   * in einem Bild, das sich nicht rührt.
   */
  const kasten = await leinwand.boundingBox();
  expect(kasten).not.toBeNull();
  const mitteX = kasten!.x + kasten!.width / 2;
  await alicePage.mouse.move(mitteX, kasten!.y + kasten!.height * 0.35);
  await alicePage.mouse.down();
  await alicePage.mouse.move(mitteX, kasten!.y + kasten!.height * 0.05, { steps: 8 });
  await alicePage.mouse.up();

  await expect
    .poll(async () => streifen(0, 0.1), { timeout: 5_000 })
    .toBeLessThan(obenEngVorher - 20);

  await alicePage.context().close();
});

test('ein Griff bleibt unter dem Finger gleich gross, auch bei verkleinerter Ansicht', async ({
  browser,
}) => {
  /*
   * Der Fangbereich eines Griffs ist in LEINWANDpunkten gedacht (22, etwa
   * eine Fingerkuppe) und wird in Originalpunkte zurückgerechnet. Bei einem
   * grossen Foto in einer kleineren Ansicht sind das deutlich mehr als 22
   * Originalpunkte – wer die Umrechnung weglässt, hat einen Fangkreis, der
   * mit der Bildgrösse schrumpft, und trifft den Griff nicht mehr.
   *
   * Der frühere Test konnte das nicht sehen: Sein Bild war 320 Punkte breit,
   * passte also unverkleinert auf die Arbeitsfläche, und der Massstab war 1 –
   * die Umrechnung ein Nulleffekt. Deshalb hier ausdrücklich ein Bild, das
   * grösser ist als die Arbeitsfläche, und ein Klick DANEBEN statt darauf.
   */
  const alice = credentials('fang');
  const bob = credentials('fziel2');
  const alicePage = await signUp(browser, alice);
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'gross.png',
    mimeType: 'image/png',
    buffer: grauesPng(1920, 1440),
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  const leinwand = alicePage.locator('.bild-leinwand');
  await expect(leinwand).toBeVisible({ timeout: 30_000 });

  await alicePage.getByRole('button', { name: /Bereiche$/ }).click();
  await alicePage.getByRole('button', { name: '↗ Verlauf' }).click();
  await alicePage.getByRole('button', { name: '👁 Maske zeigen' }).click();

  const streifenUnten = async () =>
    alicePage.evaluate(() => {
      const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
      const ctx = c?.getContext('2d');
      const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
      if (!c || !d) return -1;
      let summe = 0;
      let n = 0;
      for (let y = Math.round(c.height * 0.75); y < c.height; y += 1)
        for (let x = 0; x < c.width; x += 1) {
          summe += d[(y * c.width + x) * 4];
          n += 1;
        }
      return summe / n;
    });

  const belichtung = alicePage.locator('.bild-panel').getByRole('slider', { name: /Belichtung/ });
  await belichtung.fill('-2');
  await expect.poll(streifenUnten, { timeout: 5_000 }).toBeLessThan(70);
  const vorZug = await streifenUnten();

  /*
   * Jetzt der Zug – und zwar DANEBEN.
   *
   * Der Achsengriff liegt bei 35 % der Höhe. Angefasst wird 18
   * Leinwandpunkte darunter. Der richtige Fangbereich sind 22
   * Leinwandpunkte, also trifft es. Ohne die Umrechnung wären es
   * 22 · faktor ≈ 14 Leinwandpunkte, und 18 läge daneben – der Verlauf
   * bliebe stehen, wo er ist.
   *
   * Nachgemessen wurde die Grenze mit einer Reihe von Zügen bei 0, 8, 14, 18,
   * 22 und 30 Leinwandpunkten Abstand, jeder auf einer frischen Seite: bis
   * einschliesslich 22 fasst der Griff, bei 30 nicht mehr. Das ist genau der
   * umgerechnete Fangbereich. 18 liegt darin und zugleich oberhalb der 14,7,
   * die ohne Umrechnung übrig blieben.
   */
  /*
   * Erst JETZT messen, kurz vor dem Zug – und nicht beim Öffnen des Editors.
   *
   * Die Leinwand bekommt ihre Grösse erst, wenn das Bild geladen und die
   * Fläche vermessen ist; bis dahin steht sie auf den 300 × 150 Punkten, die
   * HTML einer Leinwand ohne Angabe gibt. Und sobald der Bereichsreiter
   * aufgeht, schrumpft sie noch einmal, weil das Bedienfeld Platz braucht.
   *
   * Ein früher gelesener Wert ist also gleich doppelt falsch. Mit den 300
   * statt 1280 Punkten wurde aus dem gewollten Abstand von 18 Leinwandpunkten
   * einer von 77 – weit ausserhalb jedes Fangbereichs. Der Test schlug fehl,
   * ohne dass am Fangbereich etwas falsch war, und je nach Ladezeit mal so
   * und mal so.
   */
  await expect
    .poll(
      async () =>
        alicePage.evaluate(() => {
          const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
          return c ? c.width : 0;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(300);
  const mass = await alicePage.evaluate(() => {
    const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
    const img = document.querySelector('.media-zoom-image') as HTMLImageElement | null;
    if (!c || !img) return null;
    return { leinwandBreite: c.width, bildBreite: img.naturalWidth };
  });
  expect(mass).not.toBeNull();
  // Der Massstab muss wirklich kleiner als 1 sein, sonst prüft der Test nichts.
  const faktor = mass!.leinwandBreite / mass!.bildBreite;
  expect(faktor, 'das Testbild ist nicht grösser als die Arbeitsfläche').toBeLessThan(0.8);

  const kasten = await leinwand.boundingBox();
  expect(kasten).not.toBeNull();
  const proLeinwandpunkt = kasten!.width / mass!.leinwandBreite;
  const mitteX = kasten!.x + kasten!.width / 2;
  const griffY = kasten!.y + kasten!.height * 0.35;
  await alicePage.mouse.move(mitteX, griffY + 18 * proLeinwandpunkt);
  await alicePage.mouse.down();
  await alicePage.mouse.move(mitteX, kasten!.y + kasten!.height * 0.9, { steps: 8 });
  await alicePage.mouse.up();

  // Der Verlauf ist nach unten gewandert: Unten wirkt er jetzt viel weniger.
  await expect.poll(streifenUnten, { timeout: 5_000 }).toBeGreaterThan(vorZug + 15);

  await alicePage.context().close();
});

test('das Netz macht aus dem Motiv eine Maske – und sagt es, wenn es aus ist', async ({
  browser,
}) => {
  /*
   * Stufe J: Dieselben Netze, mit denen das Sticker-Studio Motive freistellt,
   * liefern hier die Maske eines Bereichs. Gemessen dauert ein Lauf 1,6 bis
   * 1,8 Sekunden, deshalb ein Knopf mit Fortschritt statt einer Wirkung am
   * Regler.
   *
   * Geprüft werden beide Ausgänge:
   *  - „Motiv" ist von Haus aus ABGESCHALTET (4 MB Download). Der Knopf ist
   *    dann gesperrt, und der Grund steht LESBAR da – nicht im Tooltip. Auf
   *    einem Telefon gibt es kein Schweben, und das war schon einmal eine
   *    Meldung des Anwenders.
   *  - Eingeschaltet läuft es durch und legt ein Maskenteil an.
   */
  const alice = credentials('netz');
  const bob = credentials('nziel');
  const context = await browser.newContext();
  const alicePage = await context.newPage();
  await alicePage.goto('/');
  await alicePage.getByRole('button', { name: /Noch kein Konto/ }).click();
  await alicePage.getByLabel('Benutzername').fill(alice.username);
  await alicePage.getByLabel('Anzeigename').fill(alice.displayName);
  await alicePage.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await alicePage.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(alicePage.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'motiv.png',
    mimeType: 'image/png',
    buffer: grauesPng(640, 480),
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByRole('button', { name: /Bereiche$/ }).click();

  // Von Haus aus abgeschaltet: gesperrt, mit sichtbarer Begründung.
  await expect(alicePage.getByRole('button', { name: '🖼 Motiv' })).toBeDisabled();
  await expect(alicePage.getByText(/„Motiv“ ist abgeschaltet/)).toBeVisible();

  // „Person“ dagegen ist von Haus aus da.
  await expect(alicePage.getByRole('button', { name: '👤 Person' })).toBeEnabled();

  await context.close();
});

test('eingeschaltet erkennt das Netz das Motiv und legt daraus eine Maske an', async ({
  browser,
}) => {
  /*
   * Die andere Hälfte: Mit eingeschaltetem Verfahren läuft das Netz durch,
   * und aus seinem Ergebnis wird ein Maskenteil wie jedes andere – dieselben
   * Regler, dasselbe Umkehren, derselbe Schleier.
   *
   * Das Testbild trägt eine dunkle Gestalt auf hellem Himmel. Auf einer
   * gleichmässigen Fläche fände U²-Net zu Recht nichts, und der Test prüfte
   * den Fehlerweg statt des Erfolgswegs.
   */
  const alice = credentials('netzan');
  const bob = credentials('nzielan');
  const context = await browser.newContext();
  const alicePage = await context.newPage();
  // Vor dem ersten Laden: „Motiv“ einschalten, wie es die Einstellungen tun.
  await alicePage.addInitScript(() => {
    window.localStorage.setItem('initiative.cutout-engines', JSON.stringify({ object: true }));
  });
  await alicePage.goto('/');
  await alicePage.getByRole('button', { name: /Noch kein Konto/ }).click();
  await alicePage.getByLabel('Benutzername').fill(alice.username);
  await alicePage.getByLabel('Anzeigename').fill(alice.displayName);
  await alicePage.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await alicePage.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(alicePage.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await signUp(browser, bob);

  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Foto/Video').click();
  await alicePage.locator('input[type=file]').setInputFiles({
    name: 'motiv.png',
    mimeType: 'image/png',
    // Grösser als die 1536er Vorlage der Netze: Nur so ist die Maske
    // wirklich kleiner als das Bild, und nur dann prüft der Test die
    // Umrechnung zwischen beiden Räumen statt eines Nulleffekts.
    buffer: motivPng(1920, 1440),
  });
  await alicePage.getByRole('button', { name: /^Senden \(/ }).click();
  const bild = alicePage.locator('.media-image').first();
  await expect(bild).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => bild.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await bild.click();
  await alicePage.getByRole('button', { name: 'Bild bearbeiten' }).click();
  await expect(alicePage.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByRole('button', { name: /Bereiche$/ }).click();

  const motiv = alicePage.getByRole('button', { name: '🖼 Motiv' });
  await expect(motiv).toBeEnabled();
  await motiv.click();

  // Aus dem Netzergebnis wird ein Maskenteil – sichtbar in der Teileliste.
  const teile = alicePage.getByRole('group', { name: 'Masken des Bereichs' });
  await expect(teile.getByRole('button', { name: /Motiv/ })).toBeVisible({ timeout: 60_000 });
  // Und der Bereich trägt die Regler, wie jeder andere auch.
  await expect(
    alicePage.locator('.bild-panel').getByRole('slider', { name: /Belichtung/ }),
  ).toBeVisible();

  /*
   * Der Beweis, dass die Maske wirklich das Motiv trifft und nicht das ganze
   * Bild: Der Schleier ist rot, wo die Maske greift. In der Bildmitte (Rumpf)
   * muss er liegen, am oberen Rand (Himmel) nicht.
   */
  const rotstich = async (x0: number, x1: number, y0: number, y1: number) =>
    alicePage.evaluate(
      ({ ax, bx, ay, by }) => {
        const c = document.querySelector('.bild-leinwand') as HTMLCanvasElement | null;
        const ctx = c?.getContext('2d');
        const d = c && ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
        if (!c || !d) return -1;
        let summe = 0;
        let n = 0;
        for (let y = Math.round(c.height * ay); y < Math.round(c.height * by); y += 1)
          for (let x = Math.round(c.width * ax); x < Math.round(c.width * bx); x += 1) {
            const at = (y * c.width + x) * 4;
            summe += d[at] - d[at + 2];
            n += 1;
          }
        return n > 0 ? summe / n : -1;
      },
      { ax: x0, bx: x1, ay: y0, by: y1 },
    );

  /*
   * Nicht nur „irgendwo rot“, sondern in der richtigen FORM.
   *
   * Der Rumpf steht zwischen 33 % und 67 % der Breite. Die Maske muss dort
   * liegen und links wie rechts daneben nicht. Eine Prüfung, die nur die
   * Bildmitte anschaut, überlebte eine verscherte Maske – und genau das
   * passiert, wenn die Maskengrösse aus dem Original statt aus der 1536er
   * Vorlage genommen wird: Die Zeilenbreite stimmt dann nicht, und jede Zeile
   * rutscht ein Stück weiter zur Seite.
   */
  const amMotiv = await rotstich(0.42, 0.58, 0.55, 0.85);
  const amHimmel = await rotstich(0.42, 0.58, 0.02, 0.12);
  const linksDaneben = await rotstich(0.04, 0.16, 0.55, 0.85);
  const rechtsDaneben = await rotstich(0.84, 0.96, 0.55, 0.85);
  /*
   * Auf dem unbunten Testbild ist r − b ohne Schleier exakt null. Also:
   * deutlich positiv auf dem Motiv, praktisch null überall sonst.
   *
   * Die Schranken sind an gemessenen Zahlen ausgerichtet, nicht geraten.
   * Nimmt man die Maskengrösse aus dem Original statt aus der 1536er
   * Vorlage, stimmt die Zeilenbreite nicht: Die Maske verschert, fällt auf
   * dem Motiv auf weniger als die Hälfte und greift daneben.
   */
  expect(amMotiv, 'der Schleier liegt nicht auf dem Motiv').toBeGreaterThan(60);
  expect(amHimmel, 'der Schleier liegt auch am Himmel').toBeLessThan(6);
  expect(linksDaneben, 'der Schleier greift links neben das Motiv').toBeLessThan(6);
  expect(rechtsDaneben, 'der Schleier greift rechts neben das Motiv').toBeLessThan(6);

  await context.close();
});
