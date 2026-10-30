import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Pressen im Browser:
 *
 *  1. „Gegen den Spiegel“: Anstoßen startet SOFORT, ein Lauf mit allen vier
 *     Pfeiltasten, danach immer Atempo – und die nächste Runde beginnt von selbst.
 *  2. „Bierjunge“ / „hängt“ im Chat startet eine Partie; Echtzeit mit
 *     gemeinsamem Countdown, späteres Anstoßen kostet Zeit, und fremde Ergebnisse
 *     bleiben bis zum Rundenende verborgen.
 *  3. Rückfall in asynchron, wenn der zweite nicht rechtzeitig bereit ist.
 *
 * Die Steuerung kommt von einem kleinen Spieler IM Browser (Tastenereignisse
 * auf `window`, gelesen wird, was die Bühne als `data-*` zeigt): Von außen,
 * über Playwright, wäre jede Rückfrage ein Netz-Hin-und-Her von mehreren
 * Millisekunden – gegen eine Simulation mit 20-ms-Schritt zu träge.
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

/** Läuft im Browser: steuert, bis das Glas leer ist. Gibt die Spieldauer in ms zurück. */
async function bisLeerSpielen(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((fertig, fehler) => {
        const feld = document.querySelector<HTMLElement>('[data-testid="pressen-feld"]');
        if (!feld) {
          fehler(new Error('Keine Bühne'));
          return;
        }
        const unten: Record<string, boolean> = {};
        const taste = (key: string, an: boolean) => {
          if (Boolean(unten[key]) === an) return;
          unten[key] = an;
          window.dispatchEvent(
            new KeyboardEvent(an ? 'keydown' : 'keyup', { key, bubbles: true, cancelable: true }),
          );
        };
        const zahl = (name: string) => Number(feld.dataset[name]);
        const start = performance.now();
        const takt = window.setInterval(() => {
          const jetzt = performance.now();
          if (jetzt - start > 90_000) {
            window.clearInterval(takt);
            fehler(new Error('Glas wurde nicht leer'));
            return;
          }
          if (feld.dataset.phase !== 'laeuft') return;
          if (feld.dataset.leer === '1') {
            for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']) {
              taste(k, false);
            }
            window.clearInterval(takt);
            fertig(jetzt - start);
            return;
          }
          // Wie der Test-Spieler in der Balance-Prüfung: das Glas so lenken, dass
          // der Strahl im Mund-Oval landet (vor/zurück gehört dazu), gleiten lassen
          // statt bremsen, und erst gießen, wenn es passt.
          const x = zahl('glasX');
          const y = zahl('glasY');
          const vx = zahl('vx');
          const vy = zahl('vy');
          const fuell = zahl('fuellung');
          const ueber = 20;
          const reich = 55 + 2 * ueber;
          const fehlerX = 500 - (x + vx * 0.22);
          const fehlerY = 210 + reich - (y + vy * 0.22);
          const restX = fehlerX - vx * 0.15;
          const restY = fehlerY - vy * 0.15;
          taste('ArrowRight', restX > 12);
          taste('ArrowLeft', restX < -12);
          taste('ArrowDown', restY > 12);
          taste('ArrowUp', restY < -12);
          const ausgerichtet =
            Math.abs(fehlerX) < 50 &&
            Math.abs(fehlerY) < 34 &&
            Math.abs(vx) < 90 &&
            Math.abs(vy) < 90;
          const schwelle = 20 + 70 * (1 - fuell / 300);
          const nah = Math.hypot(fehlerX, fehlerY) < 160;
          const soll = ausgerichtet ? schwelle + ueber : nah ? schwelle - 4 : 0;
          const winkel = zahl('neigung') + zahl('neigungV') * 0.15;
          taste(' ', fuell > 0 && winkel < soll);
        }, 25);
      }),
  );
}

async function neuerChat(page: Page, mit: ReturnType<typeof credentials>) {
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(mit.username);
  await page.getByText(mit.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

async function schreibe(page: Page, text: string) {
  const feld = page.getByPlaceholder('Nachricht schreiben');
  await feld.fill(text);
  await feld.press('Enter');
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible();
}

test('Pressen gegen den Spiegel: Anstoßen sofort, vier Richtungen, Atempo, nächste Runde von selbst', async ({
  browser,
}) => {
  const alice = credentials('presse');
  const bob = credentials('gegner');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  // Direktchat mit Bob, dann Spiel → Pressen → allein üben.
  await neuerChat(alicePage, bob);
  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Spiel', { exact: true }).click();
  await alicePage.getByRole('radio', { name: /Pressen/ }).click();
  // Ohne den Schalter wäre es ein Duell mit Bob.
  await expect(alicePage.getByTestId('pressen-aufstellung')).toContainText('Zu zweit');
  await alicePage.getByLabel('Allein üben – gegen den Spiegel').check();
  await expect(alicePage.getByTestId('pressen-aufstellung')).toContainText('Gegen den Spiegel');
  await alicePage.getByRole('button', { name: 'Spiel starten' }).click();

  // Das Brett: Malus angezeigt (im Spiegel aus), kein „Los! Lauf starten“ mehr.
  const feld = alicePage.getByTestId('pressen-feld');
  await expect(feld).toBeVisible({ timeout: 15_000 });
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');
  await expect(alicePage.getByRole('button', { name: /Lauf starten/ })).toHaveCount(0);

  // Das Strichmännchen lässt sich anpassen, wird im Konto gespeichert und überlebt das Neuladen.
  await alicePage.getByTestId('pressen-figur-aendern').click();
  await alicePage.getByRole('radio', { name: 'Sonnenbrille' }).click();
  await alicePage.getByRole('radio', { name: 'Zylinder' }).click();
  // Die Auswahl bleibt stehen, auch wenn das Brett im Hintergrund neu zeichnet.
  await alicePage.waitForTimeout(1500);
  await expect(alicePage.getByRole('radio', { name: 'Sonnenbrille' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await alicePage.getByRole('button', { name: 'Speichern' }).click();
  await expect(
    alicePage.locator('.pressen-feld .pressen-figur rect[fill="#14121a"]').first(),
  ).toBeAttached();

  // „Anstoßen“ startet den Lauf SOFORT – kein Countdown, kein Zwischenschritt.
  const anstossen = alicePage.getByRole('button', { name: /Anstoßen/ });
  await expect(anstossen).toBeEnabled();
  await anstossen.click();
  await expect(feld).toHaveAttribute('data-phase', 'laeuft', { timeout: 1500 });
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
  // … und die nächste Runde beginnt von selbst (kein weiteres Anstoßen).
  await expect(feld).toHaveAttribute('data-phase', 'laeuft', { timeout: 10_000 });
  // Der Malus wächst im Spiegel nicht.
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');

  // Nach dem Neuladen steht die Runde 2 weiter (vom Server), und sie läuft wieder an.
  await alicePage.reload();
  await expect(alicePage.getByTestId('pressen-feld')).toHaveAttribute('data-runde', '2', {
    timeout: 15_000,
  });
  await expect(
    alicePage.locator('.pressen-feld .pressen-figur rect[fill="#14121a"]').first(),
  ).toBeAttached();

  await alicePage.context().close();
  await bobPage.context().close();
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

  await bobPage.waitForTimeout(1800);
  await bobPage.getByRole('button', { name: /Vorzeitig abstellen/ }).click();

  // Jetzt ist die Runde entschieden: Alice war früher dran, Bobs Wartezeit steckt in seiner Dauer.
  await expect(alicePage.locator('.pressen-wertung')).toContainText('Endwertung', {
    timeout: 15_000,
  });
  await expect(bobPage.locator('.pressen-wertung')).toContainText('Endwertung', {
    timeout: 15_000,
  });
  const zeilen = await alicePage.locator('.pressen-wertung li').allInnerTexts();
  const sekunden = zeilen.map((z) => Number((/([\d,]+) s \+/.exec(z) ?? [])[1]?.replace(',', '.')));
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
