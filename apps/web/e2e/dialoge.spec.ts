import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Zwei Dinge, die auf einem Handy den Unterschied machen.
 *
 * 1. Die Zurück-Taste schliesst einen offenen Dialog, statt aus dem Chat zu
 *    springen. Ohne das ist sie eine Falle: Man tippt auf Plus, will das Blatt
 *    wieder loswerden, drückt Zurück – und steht in der Chatübersicht.
 *
 * 2. Die Maße einer Medienblase. Das gilt für Foto UND Video: beide benutzen
 *    denselben Rahmen, und der war null Pixel breit. Der Fehler wurde am Foto
 *    gemeldet, betraf aber das Video genauso.
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

async function chatOeffnen(browser: Browser, prefix: string): Promise<Page> {
  const ich = credentials(prefix);
  const andere = credentials(`${prefix}z`);
  const page = await signUp(browser, ich);
  await signUp(browser, andere);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(andere.username);
  await page.getByText(andere.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  return page;
}

test('Zurück schliesst den offenen Dialog, nicht den Chat', async ({ browser }) => {
  const page = await chatOeffnen(browser, 'zur');

  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await expect(page.getByRole('heading', { name: 'Hinzufügen' })).toBeVisible();

  await page.goBack();

  // Das Blatt ist zu …
  await expect(page.getByRole('heading', { name: 'Hinzufügen' })).toHaveCount(0);
  // … und der Chat steht noch.
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
});

test('ohne offenen Dialog führt Zurück wie gewohnt aus dem Chat', async ({ browser }) => {
  // Die Gegenprobe. Ein Verlaufseintrag, der beim Schliessen liegen bliebe,
  // würde zwei Mal Zurück verlangen – und die Taste damit kaputtmachen.
  const page = await chatOeffnen(browser, 'raus');

  // Einmal auf und wieder zu, damit ein etwaiger Rest auffällt.
  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await expect(page.getByRole('heading', { name: 'Hinzufügen' })).toBeVisible();
  await page.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('heading', { name: 'Hinzufügen' })).toHaveCount(0);

  // Kurz warten, bis der Verlaufseintrag wirklich zurückgenommen ist. Das
  // geschieht aufgeschoben (siehe lib/dialogVerlauf.ts) – ein Mensch braucht
  // fürs Antippen länger als der Browser für einen Durchgang, ein Test nicht.
  await page.waitForFunction(() => !(window.history.state as { initiativeDialog?: boolean } | null)?.initiativeDialog);

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
});

test('Foto- und Videoblasen haben eine Fläche', async ({ browser }) => {
  const page = await chatOeffnen(browser, 'mass');

  /**
   * Gemessen wird an genau der Auszeichnung, die ImageBubble und VideoBubble
   * erzeugen. Der gemeldete Fehler steckte in der Breitenberechnung des
   * Rahmens – nicht in den Daten –, deshalb genügt und trägt die Auszeichnung
   * allein. So lässt sich auch das Video prüfen, ohne eine echte Videodatei
   * durch den Browser zu schicken.
   */
  const masse = await page.evaluate(() => {
    const messen = (innen: string) => {
      const halter = document.createElement('div');
      halter.className = 'msg-col';
      halter.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start';
      halter.innerHTML = `<div class="media-bubble">${innen}</div>`;
      document.body.appendChild(halter);
      const rahmen = halter.querySelector('.media-frame') as HTMLElement;
      const breite = Math.round(rahmen.getBoundingClientRect().width);
      const hoehe = Math.round(rahmen.getBoundingClientRect().height);
      halter.remove();
      return { breite, hoehe };
    };

    return {
      foto: messen('<button class="media-frame"><img class="media-image"></button>'),
      video: messen('<div class="media-frame"><video class="media-video"></video></div>'),
      raster: messen(
        '<div class="media-grid media-grid-3">' +
          '<button class="media-frame"><img class="media-image"></button>'.repeat(3) +
          '</div>',
      ),
      mitText: messen(
        '<button class="media-frame"><img class="media-image"></button>' +
          '<p class="media-caption">ok</p>',
      ),
    };
  });

  for (const [was, mass] of Object.entries(masse)) {
    expect(mass.breite, `${was}: der Rahmen hat keine Breite`).toBeGreaterThan(80);
    expect(mass.hoehe, `${was}: der Rahmen hat keine Höhe`).toBeGreaterThan(60);
  }

  // Und der Text bestimmt die Größe nicht.
  expect(masse.mitText.breite).toBe(masse.foto.breite);
});
