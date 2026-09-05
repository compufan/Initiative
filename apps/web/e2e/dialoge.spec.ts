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
  await page.waitForFunction(
    () => !(window.history.state as { initiativeDialog?: boolean } | null)?.initiativeDialog,
  );

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

test('die Seite „Verwendete Software“ nennt die fremden Bestandteile samt Lizenztext', async ({
  browser,
}) => {
  /*
   * Kein Beiwerk, sondern eine Auflage. Die MIT-Lizenz – unter der die
   * meisten hier benutzten Pakete stehen – verlangt wörtlich: „The above
   * copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.“ Eine Web-App verteilt
   * Kopien an jeden Besucher. Ohne diese Seite fehlte diese Nennung bei jedem
   * einzelnen Paket.
   *
   * Geprüft wird deshalb nicht, dass „eine Liste da ist“, sondern dass die
   * drei Dinge dastehen, die die Lizenzen verlangen: Name, Rechteinhaber und
   * der Lizenztext selbst.
   */
  const nutzer = credentials('lizenz');
  const seite = await signUp(browser, nutzer);

  await seite.goto('/profil/lizenzen');
  await expect(seite.getByRole('heading', { name: 'Verwendete Software' })).toBeVisible();

  // Die Liste wird nachgeladen – erst wenn die Gruppen da sind, ist sie da.
  const suche = seite.getByRole('searchbox', { name: 'Verwendete Software durchsuchen' });
  await expect(suche).toBeVisible({ timeout: 20_000 });

  // Alle vier Gruppen: Browser, Rechenwerke, Modelle, Server.
  for (const titel of ['Im Browser', 'Fest in den Rechenwerken', 'Modelle', 'Auf dem Server']) {
    await expect(seite.getByRole('heading', { name: new RegExp(titel) })).toBeVisible();
  }

  // Ein Paket, von dem wir sicher wissen, dass es ausgeliefert wird.
  await suche.fill('react-dom');
  const reactDom = seite.getByRole('button', { name: /^react-dom/ }).first();
  await expect(reactDom).toBeVisible();
  await reactDom.click();

  // Rechteinhaber und Lizenztext – beides verlangt die MIT-Lizenz.
  await expect(seite.getByText(/Copyright \(c\) Meta Platforms/).first()).toBeVisible();
  await expect(
    seite
      .getByText(/The above copyright notice and this permission notice shall be included/)
      .first(),
  ).toBeVisible();

  /*
   * Und das Tiefenmodell mit seinem Vorbehalt: Nur die kleine Fassung ist
   * Apache-2.0. Steht dieser Satz nicht in der App, kann ihn auch niemand
   * lesen, der die App weitergibt.
   */
  await suche.fill('depth-anything');
  const tiefe = seite.getByRole('button', { name: /^depth-anything/ }).first();
  await expect(tiefe).toBeVisible();
  await tiefe.click();
  await expect(seite.getByText(/Apache License/).first()).toBeVisible();

  await seite.context().close();
});
