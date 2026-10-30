import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Gemeinsame Hilfen der Pressen-Tests: Konto anlegen, einen Lauf im Browser
 * spielen (Tastenereignisse auf `window`, gelesen wird, was die Bühne als `data-*`
 * zeigt), Chat und Spiegel-Übung öffnen.
 */

export function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

export async function signUp(
  browser: Browser,
  user: ReturnType<typeof credentials>,
): Promise<Page> {
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
export async function bisLeerSpielen(page: Page): Promise<number> {
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

export async function neuerChat(page: Page, mit: ReturnType<typeof credentials>) {
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(mit.username);
  await page.getByText(mit.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
}

export async function schreibe(page: Page, text: string) {
  const feld = page.getByPlaceholder('Nachricht schreiben');
  await feld.fill(text);
  await feld.press('Enter');
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible();
}

/** Öffnet die Spiele-Übersicht und startet die Übung gegen den Spiegel. */
export async function spiegelStarten(page: Page) {
  await page.goto('/spiele');
  await expect(page.getByTestId('spiegel-karte')).toBeVisible();
  await page.getByTestId('spiegel-starten').click();
  await expect(page.getByTestId('pressen-feld')).toBeVisible({ timeout: 15_000 });
}

/** Wie groß die Anzeige ist und wie groß das Brett: im Vollbild sind beide gleich. */
export async function fuelltAnzeige(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const brett = document.querySelector<HTMLElement>('[data-testid="pressen-brett"]');
    if (!brett) return false;
    const r = brett.getBoundingClientRect();
    return (
      Math.abs(r.width - window.innerWidth) <= 1 &&
      Math.abs(r.height - window.innerHeight) <= 1 &&
      Math.abs(r.left) <= 1 &&
      Math.abs(r.top) <= 1
    );
  });
}
