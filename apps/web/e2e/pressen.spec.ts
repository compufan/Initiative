import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Pressen, „gegen den Spiegel“: starten, einen Lauf steuern, Atempo.
 *
 * Der Spiegel trinkt synchron zum eigenen Männchen, also ist die Wertung gleich
 * und es gibt Atempo – egal, wie gut oder schlecht der Lauf war. Der Test
 * prüft damit den ganzen Weg: Startblatt (allein üben) → Server legt die
 * Einzelpartie an → Lauf mit Tastatur → Abstellen-Knopf → Ergebnis als Zug →
 * Server wertet → neue Runde (und das auch nach dem Neuladen).
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
        let letztesX = zahl('glasX');
        let letzteZeit = performance.now();
        const start = performance.now();
        const takt = window.setInterval(() => {
          const jetzt = performance.now();
          if (jetzt - start > 50_000) {
            window.clearInterval(takt);
            fehler(new Error('Glas wurde nicht leer'));
            return;
          }
          if (feld.dataset.phase !== 'laeuft') return;
          const x = zahl('glasX');
          const v = ((x - letztesX) / Math.max(1, jetzt - letzteZeit)) * 1000;
          letztesX = x;
          letzteZeit = jetzt;
          if (feld.dataset.leer === '1') {
            for (const k of ['ArrowLeft', 'ArrowRight', ' ']) taste(k, false);
            window.clearInterval(takt);
            fertig(jetzt - start);
            return;
          }
          // Wie der Test-Spieler in der Balance-Prüfung: an der Stelle anhalten,
          // dann gerade so weit kippen, wie der Mund schlucken kann.
          const halt = x + (v * Math.abs(v)) / (2 * 1800);
          const fehl = 500 - halt;
          taste('ArrowRight', fehl > 10);
          taste('ArrowLeft', fehl < -10);
          const ueberMund = Math.abs(x - 500) < 25 && Math.abs(v) < 120;
          const schwelle = 20 + 70 * (1 - zahl('fuellung') / 300);
          taste(' ', ueberMund && zahl('neigung') < schwelle + 12);
        }, 25);
      }),
  );
}

test('Pressen gegen den Spiegel: ein Lauf, Atempo, neue Runde', async ({ browser }) => {
  const alice = credentials('presse');
  const bob = credentials('gegner');
  const alicePage = await signUp(browser, alice);
  const bobPage = await signUp(browser, bob);

  // Direktchat mit Bob, dann Spiel → Pressen → allein üben.
  await alicePage.getByRole('button', { name: 'Neuer Chat' }).click();
  await alicePage.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await alicePage.getByText(bob.displayName).first().click();
  await expect(alicePage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  await alicePage.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await alicePage.getByText('Spiel', { exact: true }).click();
  await alicePage.getByRole('radio', { name: /Pressen/ }).click();
  // Ohne den Schalter wäre es ein Duell mit Bob.
  await expect(alicePage.getByTestId('pressen-aufstellung')).toContainText('Zu zweit');
  await alicePage.getByLabel('Allein üben – gegen den Spiegel').check();
  await expect(alicePage.getByTestId('pressen-aufstellung')).toContainText('Gegen den Spiegel');
  await alicePage.getByRole('button', { name: 'Spiel starten' }).click();

  // Das Brett: Steuerung, Malus aus, Start.
  await expect(alicePage.getByTestId('pressen-feld')).toBeVisible({ timeout: 15_000 });
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');
  await alicePage.getByRole('button', { name: /Los! Lauf starten/ }).click();

  // Nach dem Anlauf (3 × 0,7 s) ist die Bühne scharf; die Tasten sind vorher tot.
  await expect(alicePage.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
    timeout: 10_000,
  });
  await expect(alicePage.getByRole('button', { name: /Glas nach links/ })).toBeVisible();
  await expect(alicePage.getByRole('button', { name: /Glas neigen/ })).toBeVisible();

  const dauer = await bisLeerSpielen(alicePage);
  // Schneller als die Mundgrenze (300 ml bei 30 ml/s) geht es nicht.
  expect(dauer).toBeGreaterThan(8_000);

  // Der Abstellen-Knopf erscheint erst jetzt – schon bei leerem Glas fehlt er nicht.
  const abstellen = alicePage.getByRole('button', { name: /Abstellen!/ });
  await expect(abstellen).toBeVisible();
  // Eine Reaktion unter 120 ms ist unmenschlich, der Server wiese sie ab.
  await alicePage.waitForTimeout(300);
  await abstellen.click();

  // Spiegel: gleiche Wertung → Atempo, nächste Runde – vom Server bestätigt.
  const atempo = alicePage.locator('.pressen-atempo');
  await expect(atempo).toBeVisible({ timeout: 15_000 });
  await expect(atempo).toContainText('Runde 2');
  await alicePage.reload();
  await expect(alicePage.locator('.pressen-atempo')).toContainText('Runde 2', { timeout: 15_000 });
  // Der Malus wächst im Spiegel nicht.
  await expect(alicePage.getByTestId('pressen-malus')).toContainText('aus (Spiegel)');

  await alicePage.context().close();
  await bobPage.context().close();
});
