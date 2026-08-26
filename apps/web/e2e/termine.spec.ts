import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Der schwerste Fehler in den Terminen, festgehalten.
 *
 * Eine Notiz mit „Alle Eingeladenen“ liess sich von niemandem ausser dem
 * Verfasser speichern. Die Einstellung war da, die Absicht war da – und das
 * Ganze war funktionslos: Die App schickte bei jedem Speichern die Rechte mit,
 * und der Server nimmt die nur vom Verfasser an. Die Packliste, an der alle
 * mitschreiben sollten, konnte also niemand ändern.
 *
 * Der Test fährt genau diesen Weg: Anna schreibt, Bodo ändert.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: {
      username: `${prefix}${suffix}`,
      password: 'passwort123',
      displayName: `${prefix.toUpperCase()} ${suffix}`,
    },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(wurzel);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    {
      accessToken: sitzung.accessToken,
      refreshToken: sitzung.refreshToken,
      expiresAt: Date.now() + 3_600_000,
    },
  );
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

test('eine Notiz für „Alle Eingeladenen“ lässt sich auch von anderen speichern', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'nota');
  const bodo = await registrieren(http, 'notb');
  const alsAnna = { authorization: `Bearer ${anna.accessToken}` };

  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: alsAnna,
      data: { type: 'group', title: `Hütte ${Date.now()}`, memberIds: [bodo.user.id] },
    })
  ).json();

  const beginn = new Date();
  beginn.setDate(beginn.getDate() + 10);
  const ende = new Date(beginn.getTime() + 3_600_000);
  const titel = `Hüttenwochenende ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: alsAnna,
      data: {
        conversationId: gruppe.id,
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: ende.toISOString(),
      },
    })
  ).json();
  expect(termin.id, `Termin angelegt: ${JSON.stringify(termin)}`).toBeTruthy();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const annaPage = await seiteFuer(browser, anna, wurzel);
  const bodoPage = await seiteFuer(browser, bodo, wurzel);

  // ---- Anna schreibt die Packliste, für alle änderbar --------------------
  await annaPage.goto(`${wurzel}/kalender`);
  await annaPage.getByRole('tab', { name: 'Agenda' }).click();
  await annaPage.getByText(titel).first().click();

  // „Liste“, nicht „Notiz“: Seit beide getrennt sind, oeffnen zwei Knoepfe
  // dasselbe Formular mit verschiedener Art – und nur bei einer Liste stehen
  // die drei Rechte darin.
  await annaPage.getByRole('button', { name: 'Liste', exact: true }).click();
  await annaPage.locator('#note-title-neu').fill('Packliste');
  await annaPage.locator('#note-body-neu').fill('Schlafsack');
  // Ausdruecklich im Feld „Aendern darf“: Seit es auch „Hinzufuegen darf“
  // und „Abhaken darf“ gibt, steht die Beschriftung dreimal auf der Seite.
  await annaPage
    .locator('fieldset')
    .filter({ hasText: 'Ändern darf' })
    .getByText('Alle Eingeladenen', { exact: true })
    .click();
  await annaPage.getByRole('button', { name: 'Speichern' }).click();
  await expect(annaPage.getByText('Schlafsack')).toBeVisible({ timeout: 15_000 });

  // ---- Und jetzt Bodo. Genau hier scheiterte es. -------------------------
  await bodoPage.goto(`${wurzel}/kalender`);
  await bodoPage.getByRole('tab', { name: 'Agenda' }).click();
  await bodoPage.getByText(titel).first().click();
  await expect(bodoPage.getByText('Schlafsack')).toBeVisible({ timeout: 15_000 });

  await bodoPage.getByRole('button', { name: 'Bearbeiten' }).first().click();
  await bodoPage.locator('textarea').first().fill('Schlafsack, Stirnlampe');
  await bodoPage.getByRole('button', { name: 'Speichern' }).click();

  await expect(bodoPage.getByText('Stirnlampe')).toBeVisible({ timeout: 15_000 });

  // Und Anna sieht die Änderung.
  await annaPage.reload();
  await expect(annaPage.getByText('Stirnlampe')).toBeVisible({ timeout: 15_000 });

  await http.dispose();
  await annaPage.context().close();
  await bodoPage.context().close();
});

test('eine Packliste: jeder hakt für sich ab', async ({ browser, baseURL }) => {
  /*
   * Der Fall, den der Anwender beschrieben hat: „Kleidung, Rucksack,
   * Zahnbürste“, und jeder Eingeladene muss jeden Punkt einzeln abhaken.
   *
   * Geprüft wird das, was eine Liste von einem Text unterscheidet: dass zwei
   * Leute unabhängig voneinander abhaken, dass beide den Stand des anderen
   * sehen, und dass ein Punkt erst mit dem letzten Haken erledigt ist.
   */
  const http = await request.newContext();
  const anna = await registrieren(http, 'pla');
  const bodo = await registrieren(http, 'plb');
  const alsAnna = { authorization: `Bearer ${anna.accessToken}` };

  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: alsAnna,
      data: { type: 'group', title: `Packen ${Date.now()}`, memberIds: [bodo.user.id] },
    })
  ).json();

  const beginn = new Date();
  beginn.setDate(beginn.getDate() + 5);
  const titel = `Zeltlager ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: alsAnna,
      data: {
        conversationId: gruppe.id,
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 7_200_000).toISOString(),
        attendeeIds: [anna.user.id, bodo.user.id],
      },
    })
  ).json();

  await http.post(`${API}/calendar/events/${termin.id}/notes`, {
    headers: alsAnna,
    data: {
      title: 'Packliste',
      body: '',
      editScope: 'author',
      checkScope: 'members',
      items: [
        { text: 'Schlafsack', requiredAll: true },
        { text: 'Zahnbürste', requiredAll: true },
      ],
    },
  });

  const wurzel = baseURL ?? 'http://localhost:5173';
  const annaPage = await seiteFuer(browser, anna, wurzel);
  const bodoPage = await seiteFuer(browser, bodo, wurzel);

  for (const page of [annaPage, bodoPage]) {
    await page.goto(`${wurzel}/kalender`);
    await page.getByRole('tab', { name: 'Agenda' }).click();
    await page.getByText(titel).first().click();
    await expect(page.getByText('Packliste')).toBeVisible({ timeout: 15_000 });
  }

  const zeile = (page: Page, text: string) =>
    page.locator('.nl-punkt').filter({ hasText: text });

  // Anna hakt „Schlafsack“ ab – zwei müssen, also noch nicht fertig.
  await zeile(annaPage, 'Schlafsack').getByRole('checkbox').click();
  await expect(zeile(annaPage, 'Schlafsack').getByText('1 von 2')).toBeVisible({
    timeout: 15_000,
  });
  await expect(zeile(annaPage, 'Schlafsack')).not.toHaveClass(/is-fertig/);

  // Bodo sieht Annas Haken, hat aber selbst noch keinen.
  await bodoPage.reload();
  await expect(zeile(bodoPage, 'Schlafsack').getByText('1 von 2')).toBeVisible({
    timeout: 15_000,
  });
  await expect(zeile(bodoPage, 'Schlafsack').getByRole('checkbox')).not.toBeChecked();

  // Und mit seinem Haken ist der Punkt erledigt.
  await zeile(bodoPage, 'Schlafsack').getByRole('checkbox').click();
  await expect(zeile(bodoPage, 'Schlafsack').getByText('2 von 2')).toBeVisible({
    timeout: 15_000,
  });
  await expect(zeile(bodoPage, 'Schlafsack')).toHaveClass(/is-fertig/);

  // Die Zahnbürste bleibt davon unberührt – jeder Punkt zählt für sich.
  await expect(zeile(bodoPage, 'Zahnbürste')).not.toHaveClass(/is-fertig/);

  await http.dispose();
  await annaPage.context().close();
  await bodoPage.context().close();
});
