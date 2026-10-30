import { expect, test } from '@playwright/test';
import {
  bisLeerSpielen,
  credentials,
  fuelltAnzeige,
  neuerChat,
  schreibe,
  signUp,
  spiegelStarten,
} from './pressenHilfen.js';

/**
 * Pressen im Browser:
 *
 *  1. „Gegen den Spiegel“ ist eine Übung OHNE Chat (Spiele-Übersicht): keine Karte
 *     in einem Chat. Ein Lauf beginnt NUR durch den Knopf „Anstoßen“ (nicht durch
 *     Klick daneben, nicht durch die Leertaste außerhalb des Knopfs), geht ins
 *     Vollbild, endet mit dem großen Ergebnis „Atempo“ – und die nächste Runde
 *     beginnt nicht von selbst. Das Strichmännchen ändert man in der Übersicht.
 *  2. Ohne Fullscreen-API (iPhone-Safari) füllt eine Überlagerung die Anzeige;
 *     „Vollbild beenden“, Esc und Zurück räumen auf, Esc bricht den Lauf nicht ab.
 *  3. „Bierjunge“ / „hängt“ im Chat startet eine Partie; Echtzeit mit
 *     gemeinsamem Countdown, späteres Anstoßen kostet Zeit, fremde Ergebnisse
 *     bleiben bis zum Rundenende verborgen, danach „Du hast gewonnen“ /
 *     „Du wurdest abgeschluckt“.
 *  4. Rückfall in asynchron, wenn der zweite nicht rechtzeitig bereit ist.
 *
 * Die Steuerung kommt von einem kleinen Spieler IM Browser (Tastenereignisse
 * auf `window`, gelesen wird, was die Bühne als `data-*` zeigt): Von außen,
 * über Playwright, wäre jede Rückfrage ein Netz-Hin-und-Her von mehreren
 * Millisekunden – gegen eine Simulation mit 20-ms-Schritt zu träge.
 */

test('Pressen gegen den Spiegel: Übung ohne Chat, Anstoßen nur per Knopf, Vollbild, Ergebnis „Atempo“', async ({
  browser,
}) => {
  const alice = credentials('presse');
  const bob = credentials('gegner');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  // Es gibt einen Chat mit Bob – und die Übung taucht darin trotzdem nicht auf.
  await neuerChat(alicePage, bob);

  // Das Strichmännchen gehört zum Konto, nicht zu einer Partie: Änderung in der Übersicht.
  await alicePage.goto('/spiele');
  await alicePage.getByTestId('maennchen-anpassen').click();
  await alicePage.getByRole('radio', { name: 'Sonnenbrille' }).click();
  await alicePage.getByRole('radio', { name: 'Zylinder' }).click();
  // Die Vorschau im Blatt zeigt die Wahl sofort.
  await expect(
    alicePage
      .getByTestId('pressen-figur-editor')
      .locator('.pressen-figur rect[fill="#14121a"]')
      .first(),
  ).toBeAttached();
  await alicePage.getByRole('button', { name: 'Speichern' }).click();
  await expect(alicePage.getByTestId('pressen-figur-editor')).toHaveCount(0);

  // Die Übung: allein, ohne Chat.
  await alicePage.getByTestId('spiegel-starten').click();
  const feld = alicePage.getByTestId('pressen-feld');
  await expect(feld).toBeVisible({ timeout: 15_000 });
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');
  await expect(alicePage.getByRole('button', { name: /Lauf starten/ })).toHaveCount(0);
  await expect(alicePage.getByRole('link', { name: /Zum Chat/ })).toHaveCount(0);
  // Die Figur aus dem Konto ist im Brett.
  await expect(
    alicePage.locator('.pressen-feld .pressen-figur rect[fill="#14121a"]').first(),
  ).toBeAttached();

  // Vor dem Anstoßen startet NICHTS: weder Klick ins Brett noch daneben, noch Leertaste.
  const brett = alicePage.getByTestId('pressen-brett');
  await feld.click({ position: { x: 40, y: 80 } });
  await alicePage.locator('body').click({ position: { x: 3, y: 3 } });
  await alicePage.getByRole('heading', { level: 1 }).click();
  await alicePage.keyboard.press(' ');
  await alicePage.keyboard.press('Enter');
  await alicePage.waitForTimeout(800);
  await expect(feld).toHaveAttribute('data-phase', 'bereit');
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');

  // Leertaste auf dem fokussierten Knopf startet – ohne zugleich zu neigen.
  const anstossen = alicePage.getByTestId('pressen-anstossen');
  await expect(anstossen).toBeEnabled();
  await anstossen.focus();
  await alicePage.keyboard.press(' ');
  await expect(feld).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });
  await alicePage.waitForTimeout(300);
  await expect(feld).toHaveAttribute('data-neigung', '0');

  // Vollbild: das Brett füllt die ganze Anzeige (echt oder als Überlagerung).
  await expect(brett).not.toHaveAttribute('data-vollbild', 'aus');
  await expect.poll(() => fuelltAnzeige(alicePage)).toBe(true);
  await expect(alicePage.getByTestId('pressen-vollbild')).toContainText('Vollbild beenden');
  // Steuerkreuz mit allen vier Richtungen und der Neigeknopf.
  for (const richtung of ['links', 'rechts', 'hinten', 'vorn']) {
    await expect(
      alicePage.getByRole('button', { name: new RegExp(`Glas nach ${richtung}`) }),
    ).toBeVisible();
  }
  await expect(alicePage.getByRole('button', { name: /Glas neigen/ })).toBeVisible();

  const dauer = await bisLeerSpielen(alicePage);
  // Schneller als die Mundgrenze (300 ml bei 30 ml/s) geht es nicht.
  expect(dauer).toBeGreaterThan(8_000);
  // Es ist wirklich etwas im Mund gelandet (und nicht alles daneben gegangen).
  expect(Number(await feld.getAttribute('data-verschuettet'))).toBeLessThan(120);

  // Der Abstellen-Knopf erscheint erst jetzt – schon bei leerem Glas fehlt er nicht.
  const abstellen = alicePage.getByRole('button', { name: /Abstellen!/ });
  await expect(abstellen).toBeVisible();
  // Eine Reaktion unter 120 ms ist unmenschlich, der Server wiese sie ab.
  await alicePage.waitForTimeout(300);
  await abstellen.click();

  // Spiegel: gleiche Wertung → IMMER Atempo, Runde 2 – vom Server bestätigt …
  await expect(feld).toHaveAttribute('data-runde', '2', { timeout: 15_000 });
  // … mit dem großen Ergebnis: „Atempo“, darunter Zeit, Verschüttetes und Score.
  const ergebnis = alicePage.getByTestId('pressen-ergebnis');
  await expect(ergebnis).toBeVisible();
  await expect(ergebnis).toHaveAttribute('data-art', 'atempo');
  await expect(alicePage.getByTestId('pressen-ergebnis-titel')).toHaveText(/Atempo/);
  await expect(ergebnis.locator('[role="status"]')).toContainText('Atempo');
  const zeile = ergebnis.locator('li.ist-ich');
  await expect(zeile).toContainText('Zeit');
  await expect(zeile).toContainText('Verschüttet');
  await expect(zeile).toContainText('Score');
  const titelGroesse = await alicePage
    .getByTestId('pressen-ergebnis-titel')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(titelGroesse).toBeGreaterThanOrEqual(28);

  // Die nächste Runde beginnt NICHT von selbst – nur der Knopf startet sie.
  await alicePage.waitForTimeout(3500);
  await expect(feld).toHaveAttribute('data-phase', 'bereit');
  await expect(alicePage.getByTestId('pressen-anstossen')).toBeEnabled();
  // Der Malus wächst im Spiegel nicht.
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');

  // „Vollbild beenden“ bringt die normale Ansicht zurück …
  await alicePage.getByTestId('pressen-vollbild').click();
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');
  // … und merkt sich das: Das nächste Anstoßen geht nicht wieder ins Vollbild.
  await alicePage.getByTestId('pressen-anstossen').click();
  await expect(feld).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');
  // Ohne Vollbild bricht Esc den Lauf ab (vorzeitig abstellen).
  await alicePage.waitForTimeout(1800);
  await alicePage.keyboard.press('Escape');
  await expect(feld).toHaveAttribute('data-runde', '3', { timeout: 15_000 });

  // Nach dem Neuladen steht die Runde weiter (vom Server).
  await alicePage.reload();
  await expect(alicePage.getByTestId('pressen-feld')).toHaveAttribute('data-runde', '3', {
    timeout: 15_000,
  });

  // Die Übung steht in KEINEM Chat: keine Karte bei Alice, keine bei Bob, keine Vorschau.
  await alicePage.goto('/');
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await expect(alicePage.locator('.game-bubble')).toHaveCount(0);
  await bobPage.reload();
  await expect(bobPage.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(bobPage.locator('.chat-row, .list-row').filter({ hasText: /Pressen/ })).toHaveCount(
    0,
  );
  await bobPage.getByText(alice.displayName).first().click();
  await expect(bobPage.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await expect(bobPage.locator('.game-bubble')).toHaveCount(0);

  await alicePage.context().close();
  await bobPage.context().close();
});

test('Ohne Fullscreen-API (iPhone): Überlagerung füllt die Anzeige, Esc und Zurück räumen auf', async ({
  browser,
}) => {
  const alice = credentials('phone');
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
  });
  // Wie iPhone-Safari: weder `requestFullscreen` noch der webkit-Weg am Element.
  await context.addInitScript(() => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.requestFullscreen = undefined;
    proto.webkitRequestFullscreen = undefined;
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(alice.username);
  await page.getByLabel('Anzeigename').fill(alice.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(alice.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  await spiegelStarten(page);
  const brett = page.getByTestId('pressen-brett');
  const feld = page.getByTestId('pressen-feld');

  // „Anstoßen“ geht ins Vollbild: Überlagerung, 100 % der Anzeige, auch im Querformat.
  await page.getByTestId('pressen-anstossen').click();
  await expect(feld).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });
  await expect(brett).toHaveAttribute('data-vollbild', 'ueberlagerung');
  await expect.poll(() => fuelltAnzeige(page)).toBe(true);
  // Im Querformat steht die Bühne neben den Knöpfen, nicht darüber.
  const bf = await feld.boundingBox();
  const bn = await page.getByRole('button', { name: /Glas neigen/ }).boundingBox();
  expect(bn!.x).toBeGreaterThan(bf!.x + bf!.width - 2);

  // Esc schließt nur das Vollbild – der Lauf geht weiter.
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');
  await page.waitForTimeout(500);
  await expect(feld).toHaveAttribute('data-phase', 'laeuft');

  // Eigener Knopf „Vollbild“; die Zurück-Taste schließt erst das Vollbild, nicht die Seite.
  await page.getByTestId('pressen-vollbild').click();
  await expect(brett).toHaveAttribute('data-vollbild', 'ueberlagerung');
  await page.goBack();
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');
  await expect(feld).toBeVisible();

  // Die Seite zu verlassen räumt das Vollbild auf.
  await page.getByTestId('pressen-vollbild').click();
  await expect(brett).toHaveAttribute('data-vollbild', 'ueberlagerung');
  await page.goto('/spiele');
  await expect(page.getByTestId('spiegel-karte')).toBeVisible();
  await expect(page.getByTestId('pressen-brett')).toHaveCount(0);

  await context.close();
});

test('Echtes Vollbild: Anstoßen ruft die Fullscreen-API aus der Geste, „Vollbild beenden“ schließt sie', async ({
  browser,
}) => {
  const alice = credentials('echt');
  const page = await signUp(browser, alice);
  await spiegelStarten(page);
  const brett = page.getByTestId('pressen-brett');
  await page.getByTestId('pressen-anstossen').click();
  await expect(page.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
    timeout: 1500,
  });
  await expect(brett).not.toHaveAttribute('data-vollbild', 'aus');
  await expect.poll(() => fuelltAnzeige(page)).toBe(true);
  // Wo der Browser das echte Vollbild gewährt, ist das Brett das Vollbild-Element.
  const nativ = await page.evaluate(
    () => document.fullscreenElement?.getAttribute('data-testid') ?? null,
  );
  if (nativ) {
    expect(nativ).toBe('pressen-brett');
    await expect(brett).toHaveAttribute('data-vollbild', 'nativ');
  }
  await page.getByTestId('pressen-vollbild').click();
  await expect(brett).toHaveAttribute('data-vollbild', 'aus');
  expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  // Der Lauf geht währenddessen weiter.
  await expect(page.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft');
  // Verlassen mit Vollbild: wieder hinein, dann wegnavigieren.
  await page.getByTestId('pressen-vollbild').click();
  await page.goto('/spiele');
  expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.context().close();
});

test('Bierjunge und hängt starten eine Partie; Echtzeit mit Countdown, Versatz zählt, fremde Zeiten bleiben verborgen', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const alice = credentials('anna');
  const bob = credentials('bodo');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  await neuerChat(alicePage, bob);
  await schreibe(alicePage, 'Bierjunge');
  // Bob öffnet den Chat und antwortet.
  await bobPage.getByText(alice.displayName).first().click();
  await expect(bobPage.getByText('Bierjunge', { exact: true }).last()).toBeVisible();
  await schreibe(bobPage, 'Hängt!');

  // Beide haben die Spielkarte im Chat.
  for (const seite of [alicePage, bobPage]) {
    await expect(seite.locator('.game-bubble').last()).toBeVisible({ timeout: 15_000 });
    await expect(seite.locator('.game-bubble').last()).toContainText('Pressen');
  }
  await alicePage.locator('.game-bubble .game-bubble-cta').last().click();
  await bobPage.locator('.game-bubble .game-bubble-cta').last().click();

  const feldA = alicePage.getByTestId('pressen-feld');
  const feldB = bobPage.getByTestId('pressen-feld');
  await expect(feldA).toBeVisible({ timeout: 15_000 });
  await expect(feldB).toBeVisible({ timeout: 15_000 });
  // Der Malus ist sichtbar und beschriftet.
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('Malus (Ermüdung)');
  await expect(alicePage.getByRole('meter')).toBeVisible();

  // Vor dem Start wählt jeder: Zusammen (Echtzeit) oder Wann ich will (asynchron).
  await expect(alicePage.getByTestId('pressen-wahl')).toBeVisible();
  await alicePage.getByRole('button', { name: /Zusammen \(Echtzeit\)/ }).click();
  await expect(alicePage.getByTestId('pressen-wartet')).toContainText('Warte auf die anderen');
  await bobPage.getByRole('button', { name: /Zusammen \(Echtzeit\)/ }).click();

  // Gemeinsamer Countdown 3-2-1, danach läuft die Uhr – auch ohne Anstoßen.
  await expect(feldA).toHaveAttribute('data-start-phase', 'zaehlt', { timeout: 10_000 });
  await expect(alicePage.getByTestId('pressen-anstossen')).toBeDisabled();
  await expect(feldA).toHaveAttribute('data-start-phase', 'gestartet', { timeout: 8_000 });
  await expect(feldB).toHaveAttribute('data-start-phase', 'gestartet', { timeout: 8_000 });

  // Ein Klick ins Brett oder daneben startet nichts – nur der Knopf.
  await feldA.click({ position: { x: 40, y: 80 } });
  await alicePage.locator('body').click({ position: { x: 3, y: 3 } });
  await alicePage.waitForTimeout(500);
  await expect(feldA).toHaveAttribute('data-phase', 'bereit');

  // Alice stößt sofort an, Bob zwei Sekunden später: Er ist zwei Sekunden langsamer.
  await alicePage.getByTestId('pressen-anstossen').click();
  await expect(feldA).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });
  await bobPage.waitForTimeout(2200);
  await bobPage.getByTestId('pressen-anstossen').click();
  await expect(feldB).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });

  // Beide stellen vorzeitig ab (Rest zählt als verschüttet) – so bleibt der Test kurz.
  await alicePage.waitForTimeout(1800);
  await alicePage.getByRole('button', { name: /Vorzeitig abstellen/ }).click();
  await expect(alicePage.getByTestId('pressen-eigenes-ergebnis')).toBeVisible({ timeout: 10_000 });
  await expect(alicePage.getByTestId('pressen-eigenes-ergebnis')).toContainText('300,0 ml');

  // Bob sieht von Alice nur „fertig“ – keine Zeit, keine Menge.
  const bahnVonAlice = bobPage.getByTestId('pressen-bahn-stand').first();
  await expect(bahnVonAlice).toHaveText('fertig', { timeout: 10_000 });
  await expect(bobPage.locator('.pressen-wertung')).toHaveCount(0);
  await expect(bobPage.getByTestId('pressen-ergebnis')).toHaveCount(0);

  await bobPage.waitForTimeout(1800);
  await bobPage.getByRole('button', { name: /Vorzeitig abstellen/ }).click();

  // Jetzt ist die Runde entschieden: Alice war früher dran, Bobs Wartezeit steckt in seiner Dauer.
  await expect(alicePage.locator('.pressen-wertung')).toContainText('Endwertung', {
    timeout: 15_000,
  });
  await expect(bobPage.locator('.pressen-wertung')).toContainText('Endwertung', {
    timeout: 15_000,
  });
  // Das große Ergebnis aus Sicht jedes Spielers: Alice war früher dran.
  await expect(alicePage.getByTestId('pressen-ergebnis-titel')).toHaveText(/Du hast gewonnen/);
  await expect(bobPage.getByTestId('pressen-ergebnis-titel')).toHaveText(/Du wurdest abgeschluckt/);
  await expect(alicePage.getByTestId('pressen-ergebnis')).toHaveAttribute('data-art', 'sieg');
  await expect(bobPage.getByTestId('pressen-ergebnis')).toHaveAttribute('data-art', 'niederlage');
  // Zeit, verschüttetes Bier und Score je Spieler, die eigene Zeile hervorgehoben.
  await expect(alicePage.locator('.pressen-wertung li')).toHaveCount(2);
  await expect(alicePage.locator('.pressen-wertung li.ist-ich')).toContainText('Score');
  await expect(bobPage.locator('.pressen-wertung li.ist-ich')).toContainText('Verschüttet');
  const zeilen = await alicePage.locator('.pressen-wertung li').allInnerTexts();
  const sekunden = zeilen.map((z) =>
    Number((/Zeit\s+([\d,]+) s/.exec(z) ?? [])[1]?.replace(',', '.')),
  );
  // [Alice, Bob]: Beide liefen gleich lang, aber Bob stieß 2,2 s später an – das
  // steckt in seiner Zeit (etwas Spielraum für Alices eigene Wartezeit).
  expect(sekunden[1]! - sekunden[0]!).toBeGreaterThan(1.5);

  await alicePage.context().close();
  await bobPage.context().close();
});

test('Wer nicht rechtzeitig bereit ist, fällt auf asynchron zurück; „Wann ich will“ gilt für beide', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const alice = credentials('cora');
  const bob = credentials('dirk');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  await neuerChat(alicePage, bob);
  await schreibe(alicePage, 'bierjunge');
  await bobPage.getByText(alice.displayName).first().click();
  await expect(bobPage.getByText('bierjunge', { exact: true }).last()).toBeVisible();
  await schreibe(bobPage, 'HÄNGT');
  await expect(alicePage.locator('.game-bubble').last()).toBeVisible({ timeout: 15_000 });
  await expect(bobPage.locator('.game-bubble').last()).toBeVisible({ timeout: 15_000 });
  await alicePage.locator('.game-bubble .game-bubble-cta').last().click();
  await bobPage.locator('.game-bubble .game-bubble-cta').last().click();

  // Alice ist bereit, Bob tut nichts: Nach zehn Sekunden spielt sie unabhängig.
  await alicePage.getByRole('button', { name: /Zusammen \(Echtzeit\)/ }).click();
  await expect(alicePage.getByTestId('pressen-wartet')).toBeVisible();
  await expect(alicePage.getByTestId('pressen-async-hinweis')).toContainText(
    'Nicht alle waren rechtzeitig bereit',
    { timeout: 20_000 },
  );
  await expect(alicePage.getByTestId('pressen-anstossen')).toBeEnabled();

  // Bobs Wahl „Wann ich will“ reicht: Beide spielen unabhängig, jeder stößt selbst an.
  await bobPage.getByRole('button', { name: /Wann ich will/ }).click();
  await expect(bobPage.getByTestId('pressen-async-hinweis')).toBeVisible();
  await bobPage.getByTestId('pressen-anstossen').click();
  await expect(bobPage.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
    timeout: 1500,
  });
  // Alices Uhr läuft nicht mit: Sie hat noch nicht angestoßen.
  await expect(alicePage.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'bereit');

  await alicePage.context().close();
  await bobPage.context().close();
});
