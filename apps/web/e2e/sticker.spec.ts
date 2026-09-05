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
