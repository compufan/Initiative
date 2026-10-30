import { expect, test, type Page } from '@playwright/test';
import {
  bisLeerSpielen,
  credentials,
  neuerChat,
  schreibe,
  signUp,
  spiegelStarten,
} from './pressenHilfen.js';

/**
 * Pressen-Statistik im Browser:
 *
 *  1. Bekannte Läufe (über die Schnittstelle eingespielt) ergeben bekannte Zahlen:
 *     Kopfzahlen, Verlauf mit Tabellenalternative, Verteilung, Rekorde, Filter,
 *     Liste mit „Mehr laden“ und Sortierung, Einzelansicht, Leer- und Fehlerzustand;
 *     auf 375 px ohne Querscrollen.
 *  2. Echt gespielt (Spiegel und Duell): Die Läufe stehen in der Statistik, sind nach
 *     dem Neuladen noch da und auch dann, wenn die Übung längst aufgeräumt ist.
 *     Bobs Statistik zeigt nur seinen Lauf.
 */

/** Ein Lauf über die Schnittstelle: so, wie der Server ihn beim Rundenende bucht. */
async function uebungMitLaeufen(page: Page, laeufe: { dauer: number; verschuettet: number }[]) {
  await page.evaluate(async (werte) => {
    const token = JSON.parse(localStorage.getItem('initiative.tokens') ?? '{}').accessToken;
    const aufruf = async (pfad: string, body: unknown) => {
      const antwort = await fetch(`/api/v1${pfad}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!antwort.ok) throw new Error(`${pfad}: ${antwort.status} ${await antwort.text()}`);
      return antwort.json();
    };
    const partie = await aufruf('/games/sessions', { gameKey: 'pressen', opponentIds: [] });
    for (const [i, lauf] of werte.entries()) {
      await aufruf(`/games/sessions/${partie.id}/moves`, {
        move: {
          typ: 'ergebnis',
          runde: i + 1,
          dauerMs: lauf.dauer,
          verschuettetDezi: lauf.verschuettet,
          reaktionMs: 300,
          vorzeitig: false,
          verzoegerungMs: 0,
        },
      });
    }
  }, laeufe);
}

async function keinQuerscrollen(page: Page) {
  const breiter = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(breiter).toBeLessThanOrEqual(1);
}

test('Bekannte Läufe ergeben bekannte Zahlen; Diagramm mit Tabelle, Filter, Liste, Einzelansicht, 375 px', async ({
  browser,
}) => {
  const user = credentials('zahl');
  const page = await signUp(browser, user);
  await page.setViewportSize({ width: 375, height: 800 });

  // Vorher: Leerzustand mit Weg zum Spielen.
  await page.goto('/spiele/pressen/statistik');
  await expect(page.getByText('Noch keine Läufe')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Zu den Spielen' })).toBeVisible();

  // 3 bekannte Läufe + 20 gleichförmige = 23 (mehr als eine Seite der Liste).
  const bekannte = [
    { dauer: 12_000, verschuettet: 0 },
    { dauer: 15_000, verschuettet: 100 },
    { dauer: 18_000, verschuettet: 0 },
  ];
  const fuell = Array.from({ length: 20 }, () => ({ dauer: 20_000, verschuettet: 0 }));
  await uebungMitLaeufen(page, [...bekannte, ...fuell]);

  // Einstieg aus der Spiele-Übersicht.
  await page.goto('/spiele');
  await page.getByTestId('pressen-statistik-link').click();
  await expect(page).toHaveURL(/\/spiele\/pressen\/statistik$/);
  const kopf = page.getByTestId('stat-kopf');
  await expect(kopf).toBeVisible();

  // Kopfzahlen: 23 Läufe, alle Atempo (Spiegel), keine Quote, Beste Zeit 12,0 s.
  await expect(kopf.getByTestId('stat-laeufe')).toContainText('23');
  await expect(kopf.getByTestId('stat-siege')).toContainText('0 Niederlagen · 23 Atempo');
  await expect(kopf.getByTestId('stat-siegquote')).toContainText('–');
  await expect(kopf.getByTestId('stat-beste-zeit')).toContainText('12,0 s');
  // 12000 ms ohne Strafe; die 15 s mit 10 ml Verlust kosten 1,2 s (100 ms/ml + 2 ms/ml²).
  await expect(kopf.getByTestId('stat-beste-wertung')).toContainText('12,0 s');
  await expect(kopf.getByTestId('stat-durchschnitt-zeit')).toContainText('19,3 s');
  await expect(kopf.getByTestId('stat-durchschnitt-verschuettet')).toContainText('0,4 ml');
  await expect(kopf.getByTestId('stat-verschuettet')).toContainText('10,0 ml');
  await expect(kopf.getByTestId('stat-getrunken')).toContainText('6,89 l');
  await expect(kopf.getByTestId('stat-getruemmert')).toContainText('23');

  // Diagramm: benannt, beschrieben, mit Tabellenalternative.
  const bild = page.getByTestId('stat-linien');
  await expect(bild).toHaveAttribute('role', 'img');
  await expect(bild.locator('title').first()).toHaveText('Wertung je Lauf');
  await expect(bild.locator('desc')).toContainText('23 Läufe');
  await expect(bild.locator('desc')).toContainText('bester 12,0 s');
  await page.getByText('Als Tabelle anzeigen').first().click();
  await expect(
    page.locator('figure:has([data-testid="stat-linien"]) .stat-tabelle tbody tr').first(),
  ).toContainText('12,0');
  await expect(
    page.locator('figure:has([data-testid="stat-linien"]) .stat-tabelle tbody tr'),
  ).toHaveCount(23);
  await page.getByTestId('stat-metrik-verschuettet').click();
  await expect(page.getByTestId('stat-linien').locator('title').first()).toHaveText(
    'Verschüttet je Lauf',
  );
  await expect(page.getByTestId('stat-linien').locator('desc')).toContainText('bester 0,0 ml');
  await expect(page.getByTestId('stat-histogramm')).toBeVisible();

  // Rekorde mit Datum und Link auf den Lauf.
  const rekorde = page.getByTestId('stat-rekorde');
  await expect(rekorde).toContainText('Schnellste Zeit');
  await expect(rekorde.locator('li').first()).toContainText(/am \d{2}\.\d{2}\.\d{4}/);

  // Aufschlüsselung: nur der Spiegel, keine Gegner, kein Malus-Zusammenhang.
  await expect(page.getByTestId('stat-nach-modus')).toContainText('Gegen den Spiegel');
  await expect(page.getByTestId('stat-nach-modus')).toContainText('23');
  await expect(page.getByText('gegen den Spiegel gibt es keinen Gegner')).toBeVisible();
  await expect(page.getByText('wächst der Malus nicht')).toBeVisible();

  // 375 px: nichts läuft seitlich über.
  await keinQuerscrollen(page);

  // Liste: eine Seite, dann „Mehr laden“.
  await expect(page.getByTestId('stat-lauf')).toHaveCount(20);
  await page.getByTestId('stat-mehr').click();
  await expect(page.getByTestId('stat-lauf')).toHaveCount(23);
  await expect(page.getByTestId('stat-mehr')).toHaveCount(0);
  // Sortiert nach Zeit steht der schnellste oben; nach Sieg gefiltert ist nichts da.
  await page.getByTestId('stat-sortierung').selectOption('zeit');
  await expect(page.getByTestId('stat-lauf').first()).toContainText('12,0 s');
  await page.getByTestId('stat-ausgang').selectOption('sieg');
  await expect(page.getByTestId('stat-laeufe-leer')).toBeVisible();
  await page.getByTestId('stat-ausgang').selectOption('atempo');
  await page.getByTestId('stat-sortierung').selectOption('zeit');
  await expect(page.getByTestId('stat-lauf').first()).toContainText('12,0 s');

  // Einzelansicht: alle Angaben, direkt per Adresse erreichbar.
  await page.getByTestId('stat-lauf').first().click();
  await expect(page).toHaveURL(/\/spiele\/pressen\/statistik\/[0-9a-f-]{36}$/);
  const detail = page.getByTestId('stat-detail');
  await expect(detail).toContainText('12,0 s');
  await expect(detail).toContainText('Treffgenauigkeit');
  await expect(detail).toContainText('100 %');
  await expect(detail).toContainText('300 ms');
  await expect(page.getByTestId('pressen-lauf')).toContainText('Atempo');
  await keinQuerscrollen(page);
  await page.reload();
  await expect(page.getByTestId('stat-detail')).toContainText('12,0 s');
  await page.goto('/spiele/pressen/statistik/00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('Diesen Lauf gibt es nicht')).toBeVisible();

  // Filter: Zeitraum und Modus. Duell gibt es nicht → Leerzustand der Auswahl.
  await page.goto('/spiele/pressen/statistik');
  await page.getByTestId('stat-zeitraum-7').click();
  await expect(page.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('23');
  await page.getByTestId('stat-modus').selectOption('duell');
  await expect(page.getByText('Keine Läufe in dieser Auswahl')).toBeVisible();
  await page.getByTestId('stat-modus').selectOption('spiegel');
  await expect(page.getByTestId('stat-kopf')).toBeVisible();

  // Fehlerzustand: der Server antwortet nicht → Meldung und „Noch einmal versuchen“.
  await page.route('**/api/v1/games/pressen/statistik**', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"kaputt"}' }),
  );
  await page.getByTestId('stat-zeitraum-30').click();
  await expect(page.getByTestId('stat-fehler')).toBeVisible();
  await page.unroute('**/api/v1/games/pressen/statistik**');
  await page.getByRole('button', { name: 'Noch einmal versuchen' }).first().click();
  await expect(page.getByTestId('stat-kopf')).toBeVisible();

  await page.context().close();
});

test('Gespielte Läufe (Spiegel und Duell) stehen in der Statistik – auch nach dem Neuladen und der aufgeräumten Übung', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const alice = credentials('stata');
  const bob = credentials('statb');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  // 1. Ein Lauf gegen den Spiegel (immer Atempo).
  await spiegelStarten(alicePage);
  await alicePage.getByTestId('pressen-anstossen').click();
  await bisLeerSpielen(alicePage);
  await alicePage.waitForTimeout(300);
  await alicePage.getByRole('button', { name: /Abstellen!/ }).click();
  await expect(alicePage.getByTestId('pressen-ergebnis')).toBeVisible({ timeout: 15_000 });
  // Aus dem Ergebnis geht es direkt in die Statistik.
  await alicePage.getByTestId('pressen-ergebnis-statistik').click();
  await expect(alicePage).toHaveURL(/\/spiele\/pressen\/statistik$/);
  await expect(alicePage.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('1');
  await expect(alicePage.getByTestId('stat-kopf').getByTestId('stat-siege')).toContainText(
    '1 Atempo',
  );

  // 2. Ein Duell mit Bob, beide unabhängig („Wann ich will“).
  await alicePage.goto('/');
  await neuerChat(alicePage, bob);
  await schreibe(alicePage, 'Bierjunge');
  await bobPage.getByText(alice.displayName).first().click();
  await expect(bobPage.getByText('Bierjunge', { exact: true }).last()).toBeVisible();
  await schreibe(bobPage, 'Hängt!');
  for (const seite of [alicePage, bobPage]) {
    await expect(seite.locator('.game-bubble').last()).toBeVisible({ timeout: 15_000 });
    await seite.locator('.game-bubble .game-bubble-cta').last().click();
    // Wählt einer „Wann ich will“, spielen beide unabhängig – Bob sieht gleich den Hinweis.
    if (seite === alicePage) {
      await seite.getByRole('button', { name: /Wann ich will/ }).click();
    }
    await expect(seite.getByTestId('pressen-anstossen')).toBeEnabled();
  }
  await Promise.all(
    [alicePage, bobPage].map(async (seite) => {
      await seite.getByTestId('pressen-anstossen').click();
      await expect(seite.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
        timeout: 1500,
      });
    }),
  );
  await Promise.all([bisLeerSpielen(alicePage), bisLeerSpielen(bobPage)]);
  await alicePage.waitForTimeout(300);
  await alicePage.getByRole('button', { name: /Abstellen!/ }).click();
  await bobPage.getByRole('button', { name: /Abstellen!/ }).click();
  for (const seite of [alicePage, bobPage]) {
    await expect(seite.getByTestId('pressen-ergebnis')).toBeVisible({ timeout: 20_000 });
  }

  // Alice: zwei Läufe (Spiegel, Duell), Bob als Gegner in der Bilanz.
  await alicePage.getByTestId('pressen-ergebnis-statistik').click();
  await expect(alicePage.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('2');
  await expect(alicePage.getByTestId('stat-nach-modus')).toContainText('Duell');
  await expect(alicePage.getByTestId('stat-nach-modus')).toContainText('Gegen den Spiegel');
  const gegner = alicePage.getByTestId('stat-nach-gegner');
  await expect(gegner).toContainText(bob.displayName);
  await expect(gegner.locator('tbody tr')).toHaveCount(1);
  await expect(alicePage.getByTestId('stat-lauf')).toHaveCount(2);

  // Bob: nur sein eigener Lauf, und Alices Spiegel-Lauf kennt er nicht.
  await bobPage.getByTestId('pressen-ergebnis-statistik').click();
  await expect(bobPage.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('1');
  await expect(bobPage.getByTestId('stat-nach-gegner')).toContainText(alice.displayName);
  await expect(bobPage.getByTestId('stat-nach-modus')).not.toContainText('Gegen den Spiegel');
  await expect(bobPage.getByTestId('stat-lauf')).toHaveCount(1);

  // Einzelansicht des Duells bei Alice: Gegner Bob.
  await alicePage.getByTestId('stat-lauf').filter({ hasText: 'Duell' }).click();
  await expect(alicePage.getByTestId('stat-detail')).toContainText(bob.displayName);

  // Später: nach dem Neuladen noch da …
  await alicePage.goto('/spiele/pressen/statistik');
  await expect(alicePage.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('2');
  // … und auch, wenn die Spiegel-Übung aufgeräumt wird (eine neue ersetzt die alte).
  await alicePage.goto('/spiele');
  await alicePage.getByTestId('spiegel-starten').click();
  await expect(alicePage.getByTestId('pressen-feld')).toBeVisible({ timeout: 15_000 });
  await alicePage.goto('/spiele/pressen/statistik');
  await expect(alicePage.getByTestId('stat-kopf').getByTestId('stat-laeufe')).toContainText('2');
  await expect(alicePage.getByTestId('stat-lauf')).toHaveCount(2);

  await alicePage.context().close();
  await bobPage.context().close();
});
