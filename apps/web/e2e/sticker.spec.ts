import { crc32, deflateSync } from 'node:zlib';
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
  const menue = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Hinzufügen' }) });
  for (const eintrag of ['Kamera', 'Foto/Video', 'Sprachnachricht', 'Datei', 'Sticker']) {
    await expect(menue.getByRole('button', { name: eintrag, exact: true })).toBeVisible();
  }
});

test('ohne Grafikeinheit steht die Begründung LESBAR da, nicht im Tooltip', async ({ browser }) => {
  /*
   * Der Anwender meldete: „Der Knopf ist ausgeblendet. Ein Tooltip, wenn ich
   * darauf klicke, erscheint nicht.“
   *
   * Genau so war es gebaut, und das war der Fehler: Die Begründung stand im
   * `title` des Knopfes. Auf einem Telefon gibt es kein Schweben, und ein
   * abgeblendeter Knopf nimmt nicht einmal eine Berührung entgegen – die
   * einzige Auskunft darüber, warum „Hohe Qualität“ fehlt, lag also an der
   * einen Stelle, die auf dem Zielgerät unerreichbar ist.
   *
   * Der Test prüft deshalb ausdrücklich SICHTBAREN Text. Kopflos gestartetes
   * Chromium bringt kein WebGPU mit – das ist hier kein Mangel, sondern
   * genau der Fall, um den es geht.
   */
  const alice = credentials('gpu');
  const context = await browser.newContext();
  const page = await context.newPage();
  // „Hohe Qualität“ ist von Haus aus aus; ohne diesen Schritt gäbe es nichts
  // zu erklären, und die Meldung soll dann auch nicht erscheinen.
  await page.addInitScript(() => {
    window.localStorage.setItem('initiative.cutout-engines', JSON.stringify({ birefnet: true }));
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  // Ins Studio geht es über einen Chat – so, wie der Anwender auch dorthin
  // kommt. Ein direkter Aufruf gibt es nicht.
  const bob = credentials('gziel');
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();
  await page.getByRole('tab', { name: 'Freistellen' }).click();

  // Sichtbar, ohne Schweben, ohne Klick auf einen toten Knopf.
  const hinweis = page.getByText('„Hohe Qualität“ geht auf diesem Gerät nicht');
  await expect(hinweis).toBeVisible({ timeout: 15_000 });

  // Und der Knopf ist abgeblendet statt scheinbar bedienbar.
  await expect(page.getByRole('button', { name: /Hohe Qualität/ })).toBeDisabled();

  await context.close();
});

test('das Freistellen bietet genau fünf Knöpfe, und Antippen ist einer davon', async ({
  browser,
}) => {
  /*
   * Der Anwender hat die Reihe selbst festgelegt: „Nur noch die Knöpfe:
   * Gesicht, Person, Niedrige Qualität, Hohe Qualität und Antippen."
   *
   * Vorher waren es bis zu acht, verteilt über vier Reihen – „Antippen zum
   * Behalten" stand als Werkzeug ganz woanders als die Verfahren, und
   * „Freistellen zurücknehmen" sass mit in derselben Reihe, aus fünf wurden
   * also nach jedem Lauf sechs.
   */
  const alice = credentials('fuenf');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  const bob = credentials('fziel');
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();
  await page.getByRole('tab', { name: 'Freistellen' }).click();

  const reihe = page.getByRole('group', { name: 'Freistellen' });
  await expect(reihe.getByRole('button')).toHaveCount(5);
  for (const name of ['Gesicht', 'Person', 'Niedrige Qualität', 'Hohe Qualität', 'Antippen']) {
    await expect(reihe.getByRole('button', { name: new RegExp(name) })).toHaveCount(1);
  }
  // „Antippen (genau)" darf es als eigenen Knopf nicht mehr geben.
  await expect(page.getByRole('button', { name: /Antippen \(genau\)/ })).toHaveCount(0);

  await context.close();
});

test('Bewegen dreht das Bild, und die Formen umfassen Karte und Sprechblase', async ({
  browser,
}) => {
  /*
   * Stufe 2 der Sticker-Erstellung: Drehen und echte Formen.
   *
   * Beides fehlte, und beides gehört zum Handwerkszeug jeder Sticker-App.
   * Der Test prüft, was der Anwender sieht – einen Regler, der wirkt, und
   * fünf Formen statt drei.
   */
  const alice = credentials('dreh');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  const bob = credentials('dziel');
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  await page.getByRole('tab', { name: 'Bewegen' }).click();
  const drehregler = page.getByRole('slider', { name: /Drehen/ });
  await expect(drehregler).toBeVisible();
  await expect(drehregler).toHaveValue('0');
  // „Gerade" ist abgeblendet, solange nichts gedreht ist.
  await expect(page.getByRole('button', { name: 'Gerade' })).toBeDisabled();

  await page.getByRole('button', { name: 'Eine Vierteldrehung nach rechts' }).click();
  await expect(drehregler).toHaveValue('90');
  await page.getByRole('button', { name: 'Eine Vierteldrehung nach rechts' }).click();
  await expect(drehregler).toHaveValue('180');
  // Und weiter: 270° stünden nicht am Regler, −90° schon.
  await page.getByRole('button', { name: 'Eine Vierteldrehung nach rechts' }).click();
  await expect(drehregler).toHaveValue('-90');

  await page.getByRole('button', { name: 'Gerade' }).click();
  await expect(drehregler).toHaveValue('0');

  await page.getByRole('tab', { name: 'Form' }).click();
  for (const name of ['Quadrat', 'Karte', 'Kreis', 'Sprechblase', 'Frei']) {
    await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(1);
  }

  await context.close();
});

test('ein fertiger Sticker laesst sich auch wirklich speichern', async ({ browser }) => {
  /*
   * Der Anwender meldete: „Ich konnte meinen erstellten Sticker nicht
   * speichern, weil die Schaltfläche weiter nichts tat und es auch keinen
   * anderen Speicherbutton gab."
   *
   * Es war meine Regression. Für Stufe 2 habe ich `.stk-studio` von
   * Stapelebene 55 auf 75 gehoben, damit das Studio über dem Bildbetrachter
   * (70) liegt – und damit lag es auch über dem Blatt (`.sheet`, 61), das der
   * Knopf „Weiter" öffnet. Das Blatt ging auf, war aber hinter dem Studio
   * begraben: kein Fehler, keine Meldung, nichts.
   *
   * Der Test prüft deshalb beides: dass das Blatt kommt UND dass es oben
   * liegt. Nur „ist im Baum" wäre genau die Prüfung, die hier grün geblieben
   * wäre.
   */
  const alice = credentials('sichern');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  const bob = credentials('sziel');
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  // Ein Emoji ist die kürzeste Quelle – es geht hier nicht ums Freistellen.
  await page.getByRole('button', { name: 'Emoji-Sticker 😀' }).click();
  await expect(page.locator('.stk-canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Weiter' }).click();

  /*
   * Das Blatt ist da – und zwar bedienbar.
   *
   * Geprüft wird mit einem echten Klick auf „Speichern“ und nicht mit
   * `toBeVisible`: Sichtbar WAR das Blatt die ganze Zeit, es lag nur hinter
   * dem Studio. Playwright bricht bei einem verdeckten Ziel mit „intercepts
   * pointer events“ ab, und genau das ist der Fehler, den der Anwender
   * gemeldet hat.
   */
  const blatt = page.locator('.sheet').last();
  await expect(blatt.getByRole('heading', { name: 'Sticker speichern' })).toBeVisible({
    timeout: 15_000,
  });
  await blatt.getByPlaceholder('z. B. Familie').fill('Prüfpaket');
  await blatt.getByRole('button', { name: 'Speichern', exact: true }).click();

  // Und der Sticker ist wirklich angelegt: Das Studio schliesst sich, und die
  // Sammlung zeigt ihn.
  await expect(page.locator('.stk-studio')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('Prüfpaket').first()).toBeVisible({ timeout: 15_000 });

  await context.close();
});

test('Schriftzüge lassen sich frei setzen, nicht nur oben und unten', async ({ browser }) => {
  /*
   * Vorher gab es genau zwei Plätze: mittig oben, mittig unten. Das reicht
   * für ein Meme und für sonst nichts – kein Wort neben ein Gesicht, keine
   * drei Wörter, nichts Schräges.
   *
   * # Was gemessen wird
   *
   * Nicht „ein Regler steht auf X", sondern das BILD: Wo auf der Fläche
   * stehen helle Punkte? Ein weisser Schriftzug auf durchsichtigem Grund ist
   * dafür ideal – die Schwerpunktzeile der hellen Punkte sagt, wo der Text
   * sitzt. Nach dem Ziehen nach oben muss sie deutlich weiter oben liegen.
   */
  const alice = credentials('sctxt');
  const page = await signUp(browser, alice);
  const bob = credentials('sczie');
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  await page.getByRole('tab', { name: 'Text' }).click();
  // Ohne Text steht dort ein Hinweis und kein Eingabefeld.
  await expect(page.getByText(/Noch kein Text/)).toBeVisible();

  await page.getByRole('button', { name: '＋ Text' }).click();
  const feld = page.getByLabel('Text', { exact: true });
  await expect(feld).toBeVisible();
  await feld.fill('HALLO');

  const leinwand = page.locator('.stk-canvas, canvas').first();
  await expect(leinwand).toBeVisible();
  // Warten, bis die Fläche wirklich Masse hat – ein <canvas> ohne gesetzte
  // Grösse ist 300×150 und schwarz, und man misst dann das leere Rechteck.
  await expect
    .poll(async () => leinwand.evaluate((el: HTMLCanvasElement) => el.width), { timeout: 15_000 })
    .toBeGreaterThan(200);

  /** Die mittlere Zeile aller hellen Punkte, als Anteil der Höhe. */
  const schwerpunkt = async () =>
    leinwand.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext('2d');
      if (!ctx) return -1;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      let summe = 0;
      let n = 0;
      for (let y = 0; y < el.height; y += 1)
        for (let x = 0; x < el.width; x += 1) {
          const at = (y * el.width + x) * 4;
          if (d[at + 3] > 200 && d[at] > 200 && d[at + 1] > 200 && d[at + 2] > 200) {
            summe += y;
            n += 1;
          }
        }
      return n < 20 ? -1 : summe / n / el.height;
    });

  await expect.poll(schwerpunkt, { timeout: 15_000 }).toBeGreaterThan(0);
  const vorher = await schwerpunkt();

  /*
   * Nach unten ziehen, nicht nach oben.
   *
   * Der erste Schriftzug entsteht bei y = 0,14 – oben. Der erste Anlauf
   * dieses Tests zog ihn nach 0,12 und stellte dann fest, dass sich nichts
   * bewegt hatte: Er war schon dort. Eine Prüfung, die den Text an seinen
   * eigenen Platz schiebt, beweist nichts.
   */
  const kasten = await leinwand.boundingBox();
  expect(kasten).not.toBeNull();
  if (!kasten) return;
  expect(vorher).toBeLessThan(0.3);
  const vonY = kasten.y + kasten.height * vorher;
  await page.mouse.move(kasten.x + kasten.width / 2, vonY);
  await page.mouse.down();
  await page.mouse.move(kasten.x + kasten.width / 2, kasten.y + kasten.height * 0.8, {
    steps: 12,
  });
  await page.mouse.up();

  const nachher = await schwerpunkt();
  expect(nachher).toBeGreaterThan(0);
  expect(nachher).toBeGreaterThan(vorher + 0.4);

  // Und ein zweiter Schriftzug legt sich nicht auf den ersten.
  await page.getByRole('button', { name: '＋ Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('WELT');
  await expect(page.getByRole('button', { name: 'HALLO' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'WELT' })).toBeVisible();

  await page.close();
});

/* Aus bilder.spec.ts übernommen – ein erkennbares Motiv, im Test gebaut. */
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

/**
 * Ein Bild mit einem HORIZONT, der um `grad` schief steht.
 *
 * Oben hell, unten dunkel, dazwischen eine harte Kante. Genau das, wofür es
 * das Geraderichten gibt – und etwas, dessen Schieflage sich hinterher in
 * einer Zahl messen lässt: In welcher Zeile liegt die Kante, Spalte für
 * Spalte? Bei einem geraden Horizont in jeder Spalte in derselben.
 */
function horizontPng(breite: number, hoehe: number, grad: number): Buffer {
  const steigung = Math.tan((grad * Math.PI) / 180);
  const mitte = hoehe / 2;
  return pngAus(breite, hoehe, (x, y) => {
    // Unbunt, damit die Messung nur Helligkeit sieht.
    const kante = mitte + (x - breite / 2) * steigung;
    return y < kante ? [225, 225, 225] : [45, 45, 45];
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

test('„Hohe Qualität" rechnet im eigenen Arbeiter – und meldet sich, wenn es scheitert', async ({
  browser,
}) => {
  /*
   * Der Umbau, den dieser Test absichert: BiRefNet lief bisher im Hauptfaden.
   * 94 MB Modell einlesen, den Graphen bauen und die Shader übersetzen ist
   * synchrone Arbeit am Stück – währenddessen steht die Oberfläche.
   *
   * # Was hier geprüft werden KANN und was nicht
   *
   * Dieser Rechner hat keine Grafikeinheit (`navigator.gpu` fehlt). Ein
   * echter Lauf ist also nicht zu haben, und die Frage „wie viel schneller
   * fühlt es sich an" lässt sich hier nicht beantworten – sie steht im
   * Protokoll der App, damit sie auf einem echten Telefon beantwortet wird.
   *
   * Prüfbar ist die ganze KETTE davor, und die ist der eigentliche Umbau:
   * Die Gerätefrage sagt ja, der Arbeiter wird gebaut, er startet, er lädt
   * seine Laufzeit – und wenn es dann nicht weitergeht, kommt eine Nachricht
   * zurück statt Stille. Genau das ist der Unterschied zum eingebauten
   * Proxy-Arbeiter, der mit WebGPU still in einer nicht unterstützten Fassung
   * weiterliefe.
   *
   * Dafür wird `navigator.gpu` vorgetäuscht: Adapter da, `shader-f16` da.
   * Damit läuft alles bis zur Stelle, an der es echte Hardware bräuchte.
   */
  const alice = credentials('bfnw');
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    /*
     * Ein Adapter, der behauptet zu können, was gebraucht wird.
     *
     * `defineProperty` und nicht schlicht zuweisen: `navigator.gpu` ist in
     * Chromium ein Nur-Lese-Zugriff. Eine Zuweisung wirft im strikten Modus,
     * und ein geworfener Fehler im Init-Skript nimmt die ganze Seite mit –
     * der erste Anlauf dieses Tests kam deshalb nicht einmal bis zum
     * Anmeldebildschirm.
     */
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        requestAdapter: async () => ({ features: { has: (n: string) => n === 'shader-f16' } }),
      },
    });
    /*
     * „Hohe Qualität" ist von Haus aus abgeschaltet – 94 MB lädt niemand
     * ungefragt.
     *
     * In try/catch, weil ein Init-Skript auch auf `about:blank` läuft. Dort
     * wirft jeder Zugriff auf `localStorage` einen SecurityError, und der
     * nimmt das ganze Skript mit – samt der Grafikeinheit oben.
     */
    try {
      localStorage.setItem('initiative.cutout-engines', JSON.stringify({ birefnet: true }));
    } catch {
      /* kommt beim nächsten Aufruf mit echtem Ursprung */
    }
  });

  const arbeiter: string[] = [];
  page.on('worker', (w) => arbeiter.push(w.url()));

  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  const bob = credentials('bfziel');
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  // Ein Bild, damit das Freistellen überhaupt angeboten wird.
  await page.getByRole('tab', { name: 'Quelle' }).click();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'motiv.png',
      mimeType: 'image/png',
      buffer: motivPng(256, 256),
    });

  await page.getByRole('tab', { name: 'Freistellen' }).click();
  const knopf = page.getByRole('button', { name: /Hohe Qualität/ });
  await expect(knopf).toBeEnabled({ timeout: 15_000 });
  await knopf.click();

  /*
   * Der Arbeiter muss entstehen. Ohne ihn läge die ganze Arbeit wieder im
   * Hauptfaden – der Umbau wäre wirkungslos, und nichts würde es verraten.
   */
  await expect
    .poll(() => arbeiter.filter((u) => u.includes('birefnet')).length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  /*
   * Und es muss eine Antwort kommen. Ein Arbeiter, der still stirbt, wäre
   * schlimmer als gar keiner: Der Anwender sähe „rechnet …" und danach für
   * immer nichts.
   */
  await expect(page.getByRole('button', { name: /Hohe Qualität/ })).not.toContainText('rechnet', {
    timeout: 60_000,
  });

  await context.close();
});

test('alle sieben Werkzeuge stehen auf dem Schirm, auch auf dem Telefon', async ({
  browser,
}, testInfo) => {
  /*
   * Der Grund für diesen Test: Die Reiterleiste war eine waagerechte Rolle
   * mit fester Mindestbreite je Reiter – 7 × 68 + 6 × 4 = 500 Punkte. Auf
   * einem Telefon mit 412 Punkten lagen „Kontur“ und „Text“ jenseits des
   * Randes, und die Rollleiste war ausgeblendet: kein Strich, kein Schatten,
   * nichts, was auf mehr hingedeutet hätte. Wer Text auf seinen Sticker
   * wollte, fand die Möglichkeit schlicht nicht.
   *
   * Gemessen wird deshalb nicht „das Element ist im DOM“, sondern ob sein
   * Rechteck wirklich innerhalb der Leiste liegt.
   */
  const alice = credentials('sctab');
  const bob = credentials('sctz');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  const leiste = page.locator('.stk-tabs');
  await expect(leiste).toBeVisible();
  const leistenKasten = await leiste.boundingBox();
  expect(leistenKasten).not.toBeNull();

  const namen = ['Quelle', 'Bewegen', 'Form', 'Freistellen', 'Detail', 'Kontur', 'Text'];
  for (const name of namen) {
    const reiter = page.getByRole('tab', { name });
    const kasten = await reiter.boundingBox();
    expect(kasten, `„${name}“ hat kein Rechteck`).not.toBeNull();
    if (!kasten || !leistenKasten) continue;
    expect(
      kasten.x >= leistenKasten.x - 1,
      `„${name}“ beginnt links ausserhalb der Leiste (${testInfo.project.name})`,
    ).toBe(true);
    expect(
      kasten.x + kasten.width <= leistenKasten.x + leistenKasten.width + 1,
      `„${name}“ endet rechts ausserhalb der Leiste (${testInfo.project.name})`,
    ).toBe(true);
    // Und gross genug zum Treffen.
    expect(kasten.width, `„${name}“ ist zu schmal zum Antippen`).toBeGreaterThanOrEqual(40);
    expect(kasten.height, `„${name}“ ist zu flach zum Antippen`).toBeGreaterThanOrEqual(44);
  }

  // Und der hinterste führt wirklich zur Textbedienung.
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('button', { name: '＋ Text' })).toBeVisible();
});

test('die Sprechblase bekommt einen Körper – vorher war sie ein unsichtbarer Umriss', async ({
  browser,
}) => {
  /*
   * Der Anwender meldete: „Es gibt die Option Sprechblase bei Form, aber die
   * tut nichts."
   *
   * Er hatte recht, und der bestehende Test half nicht: Der prüfte, dass der
   * Knopf DA ist, nie dass er etwas bewirkt. Eine Form schnitt nur weg, was
   * ausserhalb ihres Pfades liegt (`destination-in`) – bei einem
   * freigestellten Motiv liegt dort längst nichts mehr, also blieb das Bild
   * unverändert. Eine Blase ohne Körper ist ausserdem keine.
   *
   * Gemessen wird deshalb die Fläche selbst: Im Körper der Blase muss etwas
   * Undurchsichtiges stehen, unter ihr – neben dem Zipfel – nichts.
   */
  const alice = credentials('blase');
  const bob = credentials('bziel');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  const leinwand = page.locator('.stk-canvas, canvas').first();
  await expect(leinwand).toBeVisible();
  await expect
    .poll(async () => leinwand.evaluate((el: HTMLCanvasElement) => el.width), { timeout: 15_000 })
    .toBeGreaterThan(200);

  /** Die Deckkraft an einer Stelle, in Anteilen der Kantenlänge. */
  const deckung = async (u: number, v: number) =>
    leinwand.evaluate((el: HTMLCanvasElement, stelle: { u: number; v: number }) => {
      const ctx = el.getContext('2d');
      if (!ctx) return -1;
      const x = Math.min(el.width - 1, Math.round(stelle.u * el.width));
      const y = Math.min(el.height - 1, Math.round(stelle.v * el.height));
      return ctx.getImageData(x, y, 1, 1).data[3];
    }, { u, v });

  /** Die Farbe an einer Stelle als „r,g,b" – zum Vergleichen. */
  const farbe = async (u: number, v: number) =>
    leinwand.evaluate((el: HTMLCanvasElement, stelle: { u: number; v: number }) => {
      const ctx = el.getContext('2d');
      if (!ctx) return '';
      const x = Math.min(el.width - 1, Math.round(stelle.u * el.width));
      const y = Math.min(el.height - 1, Math.round(stelle.v * el.height));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    }, { u, v });

  /*
   * Ein Emoji als Inhalt, damit auch die zweite Hälfte geprüft ist: Die
   * Fläche muss HINTER das Motiv. Auf leerer Leinwand wäre „darüber" und
   * „darunter" nicht zu unterscheiden – und genau so kam eine Fassung mit
   * `source-over` durch die erste Version dieses Tests.
   */
  await page.locator('.stk-emoji-btn').first().click();
  await expect.poll(() => deckung(0.5, 0.5), { timeout: 15_000 }).toBeGreaterThan(200);
  const vorher = await farbe(0.5, 0.5);

  await page.getByRole('tab', { name: 'Form' }).click();
  await page.getByRole('button', { name: /Sprechblase/ }).click();

  /*
   * Gemessen wird im ZIPFEL, nicht in der Mitte: Dort liegt kein Emoji, also
   * sagt die Deckkraft dort etwas über die Blase und nichts über den Inhalt.
   */
  await expect.poll(() => deckung(0.28, 0.9), { timeout: 10_000 }).toBeGreaterThan(200);
  // Rechts unten, neben dem Zipfel, ist nichts.
  expect(await deckung(0.92, 0.93)).toBeLessThan(40);
  // Und das Emoji ist noch zu sehen, nicht übermalt.
  expect(await farbe(0.5, 0.5)).toBe(vorher);

  // „Ohne Fläche" nimmt den Körper wieder weg – die Wahl bleibt beim Anwender.
  await page.getByRole('button', { name: 'Ohne Fläche' }).click();
  await expect.poll(() => deckung(0.28, 0.9), { timeout: 10_000 }).toBeLessThan(40);
});

test('die Arbeit im Studio geht nicht mehr versehentlich verloren', async ({ browser }) => {
  /*
   * Drei Wege, auf denen ein halb fertiger Sticker bisher verschwand:
   *
   *   1. Ein Druck zu viel auf ↶ – es gab kein Wiederherstellen. Wer sich
   *      vertippte, baute seine Arbeit nach, im Zweifel samt Modelllauf.
   *   2. Ein Druck auf ✕ – ohne Rückfrage, sofort weg.
   *   3. Die Zurück-Geste – die verliess die ganze App, weil das Studio
   *      keinen Verlaufseintrag anmeldete.
   */
  const alice = credentials('verl');
  const bob = credentials('vziel');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  // Etwas Arbeit hineinlegen: ein Emoji und ein Schriftzug.
  await page.locator('.stk-emoji-btn').first().click();
  await page.getByRole('tab', { name: 'Text' }).click();
  await page.getByRole('button', { name: '＋ Text' }).click();
  const feld = page.getByLabel('Text', { exact: true });
  await feld.fill('HALLO');
  await expect(feld).toHaveValue('HALLO');

  // 1. Zurück und wieder vor.
  const zurueck = page.getByRole('button', { name: 'Rückgängig' });
  const vor = page.getByRole('button', { name: 'Wiederherstellen' });
  await expect(vor).toBeDisabled();
  await zurueck.click();
  await expect(vor).toBeEnabled();
  await vor.click();
  await expect(feld).toHaveValue('HALLO');

  // 2. Das ✕ fragt nach – und „Weiter bearbeiten" lässt alles stehen.
  await page.getByRole('button', { name: 'Editor schließen' }).click();
  await expect(page.getByText('Sticker verwerfen?')).toBeVisible();
  await page.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(page.getByText('Sticker verwerfen?')).toHaveCount(0);
  await expect(feld).toHaveValue('HALLO');

  // 3. Die Zurück-Geste bleibt in der App und fragt dasselbe.
  await page.goBack();
  await expect(page.getByText('Sticker verwerfen?')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  // Zurück im Chat, nicht ausserhalb der App.
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible({ timeout: 10_000 });
});

test('Kontur und Schatten: Farbe, Schatten – und genug Rand für beide', async ({ browser }) => {
  /*
   * Der Ablauf für die Kontur – ausweiten, weichzeichnen, einfärben,
   * darunterlegen – konnte immer schon mehr, als er durfte: Farbe, Versatz
   * und Stärke standen als feste Zahlen im Zeichencode. Damit gab es genau
   * einen weissen Rand und keinen Schatten.
   *
   * Und `FORM_RAND` stand auf 6, während der Stärkeregler bis 26 geht: Auf
   * Kreis, Karte und Sprechblase lagen zwanzig Punkte Kontur ausserhalb der
   * Fläche und wurden abgeschnitten – genau das, was dieser Rand verhindern
   * sollte.
   */
  const alice = credentials('kont');
  const bob = credentials('kziel');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);

  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Sticker', exact: true }).click();
  await page.getByRole('button', { name: /Sticker erstellen/ }).click();

  const leinwand = page.locator('.stk-canvas, canvas').first();
  await expect(leinwand).toBeVisible();
  await expect
    .poll(async () => leinwand.evaluate((el: HTMLCanvasElement) => el.width), { timeout: 15_000 })
    .toBeGreaterThan(200);

  /** Deckung und Farbe an einer Stelle, in Anteilen der Kantenlänge. */
  const punkt = async (u: number, v: number) =>
    leinwand.evaluate((el: HTMLCanvasElement, stelle: { u: number; v: number }) => {
      const ctx = el.getContext('2d');
      if (!ctx) return { a: -1, r: -1, g: -1, b: -1 };
      const x = Math.min(el.width - 1, Math.round(stelle.u * el.width));
      const y = Math.min(el.height - 1, Math.round(stelle.v * el.height));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    }, { u, v });

  await page.locator('.stk-emoji-btn').first().click();
  await expect.poll(async () => (await punkt(0.5, 0.5)).a, { timeout: 15_000 }).toBeGreaterThan(200);

  await page.getByRole('tab', { name: 'Kontur' }).click();

  /*
   * Die Konturfarbe.
   *
   * Nicht „steht irgendwo Gelb" – ein Emoji ist selbst gelb, und die erste
   * Fassung dieses Tests fand genau das. Gemessen wird deshalb DIESELBE
   * Stelle über einen Farbwechsel hinweg: Erst wird ein Punkt im weissen Saum
   * gesucht, dann die Kontur auf Schwarz gestellt, und derselbe Punkt muss
   * dunkel geworden sein. Damit kann kein Bildinhalt den Test bestehen.
   */
  const saumPunkt = await (async () => {
    for (const v of [0.5, 0.4, 0.6]) {
      for (const u of [0.7, 0.74, 0.78, 0.82, 0.86, 0.9]) {
        const f = await punkt(u, v);
        if (f.a > 200 && f.r > 200 && f.g > 200 && f.b > 200) return { u, v };
      }
    }
    return null;
  })();
  expect(saumPunkt, 'kein weisser Saum gefunden').not.toBeNull();

  await page.getByRole('button', { name: 'Kontur Schwarz' }).click();
  await expect
    .poll(
      async () => {
        const f = await punkt(saumPunkt!.u, saumPunkt!.v);
        return f.a > 150 && f.r < 100 && f.g < 100 && f.b < 100;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // Der Schatten.
  await page.getByRole('button', { name: /Schatten aus/ }).click();
  await expect(page.getByRole('button', { name: /Schatten an/ })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Weite' })).toBeVisible();

  /*
   * Genug Rand: Volle Konturstärke auf einer Sprechblase. Ohne den
   * abgeleiteten Rand schnitte die Fläche den Saum an der Kante ab – dann
   * stünde am äussersten Bildpunkt der Leinwand noch Farbe. Mit Rand ist die
   * äusserste Zeile frei.
   */
  await page.getByRole('slider', { name: 'Stärke' }).fill('26');
  await page.getByRole('tab', { name: 'Form' }).click();
  await page.getByRole('button', { name: /Sprechblase/ }).click();
  await expect.poll(async () => (await punkt(0.5, 0.06)).a, { timeout: 10_000 }).toBeGreaterThan(0);
  // Die äusserste Zeile bleibt frei – die Form endet davor.
  expect((await punkt(0.5, 0.999)).a).toBeLessThan(30);
  expect((await punkt(0.999, 0.5)).a).toBeLessThan(30);
});
