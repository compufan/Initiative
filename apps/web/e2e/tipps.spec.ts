import { expect, test, type Browser, type Page } from '@playwright/test';

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

/*
 * Tooltips durch langes Drücken.
 *
 * Zwei Dinge müssen stimmen, und das zweite ist das schwerere:
 *
 * 1. Die Blase erscheint überhaupt – auf einem Gerät ohne Maus.
 * 2. Das Lesen löst die Aktion NICHT aus. Wer lange auf „Löschen“ drückt, um
 *    nachzusehen, was der Knopf tut, hat sonst danach gelöscht. Genau daran
 *    scheitern Touch-Tooltips gewöhnlich.
 */

test('ein langer Druck zeigt den Tooltip – und löst den Knopf nicht aus', async ({ browser }) => {
  const alice = credentials('tipp');
  const page = await signUp(browser, alice);

  await page.goto('/profil');
  const knopf = page.getByRole('button', { name: 'Profilbild ändern' });
  await expect(knopf).toBeVisible();
  const kasten = await knopf.boundingBox();
  expect(kasten).not.toBeNull();
  if (!kasten) return;

  const mitteX = kasten.x + kasten.width / 2;
  const mitteY = kasten.y + kasten.height / 2;

  // Langes Drücken – mit echten Zeiger-Ereignissen, nicht mit click().
  await page.mouse.move(mitteX, mitteY);
  await page.dispatchEvent('.prf-avatar-btn', 'pointerdown', {
    pointerType: 'touch',
    clientX: mitteX,
    clientY: mitteY,
    isPrimary: true,
    pointerId: 1,
  });

  const blase = page.getByRole('tooltip');
  await expect(blase).toBeVisible({ timeout: 3000 });
  await expect(blase).toHaveText(/Ausschnitt/);

  // Die Blase darf den Knopf nicht verdecken, über den sie spricht.
  const blaseKasten = await blase.boundingBox();
  expect(blaseKasten).not.toBeNull();
  if (blaseKasten) {
    const ueberlappt =
      blaseKasten.y < kasten.y + kasten.height && blaseKasten.y + blaseKasten.height > kasten.y;
    expect(ueberlappt).toBe(false);
  }

  await page.dispatchEvent('.prf-avatar-btn', 'pointerup', {
    pointerType: 'touch',
    clientX: mitteX,
    clientY: mitteY,
    isPrimary: true,
    pointerId: 1,
  });

  /*
   * Und jetzt der eigentliche Punkt: Der Klick, der auf das Loslassen folgt,
   * muss geschluckt sein. Beim Profilbild öffnete er sonst die Dateiauswahl –
   * das lässt sich von aussen schlecht sehen, deshalb wird stattdessen
   * geprüft, ob die Erfassungsphase den Klick abfängt.
   */
  const durchgelassen = await page.evaluate(() => {
    const el = document.querySelector('.prf-avatar-btn') as HTMLElement;
    let angekommen = false;
    const horcher = () => {
      angekommen = true;
    };
    el.addEventListener('click', horcher);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.removeEventListener('click', horcher);
    return angekommen;
  });
  expect(durchgelassen).toBe(false);

  await page.close();
});

test('ohne langen Druck kommt der Klick ganz normal an', async ({ browser }) => {
  // Die Gegenprobe. Ein Tooltip, der jeden zweiten Klick frisst, wäre
  // schlimmer als gar keiner – und ein Test, der nur das Schlucken prüft,
  // wäre auch dann grün.
  const alice = credentials('tipq');
  const page = await signUp(browser, alice);

  await page.goto('/profil');
  await expect(page.getByRole('button', { name: 'Profilbild ändern' })).toBeVisible();

  const durchgelassen = await page.evaluate(() => {
    const el = document.querySelector('.prf-avatar-btn') as HTMLElement;
    let angekommen = false;
    const horcher = () => {
      angekommen = true;
    };
    el.addEventListener('click', horcher);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.removeEventListener('click', horcher);
    return angekommen;
  });
  expect(durchgelassen).toBe(true);

  await page.close();
});
