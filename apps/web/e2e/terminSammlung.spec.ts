import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * „Sammlung neu anlegen und verknüpfen“ durch die echte Oberfläche.
 *
 * Der Kern ist nicht, dass ein Knopf etwas tut, sondern **wer danach
 * hineinkommt**. Verknüpfen vergibt von sich aus keine Rechte; vor dem
 * Anlegen steht im Blatt, wer sie bekommt, und der Abschnitt „Sammlung“ im
 * Termin sagt danach, wer nicht hineinkommt. Dasselbe wird hier an der API
 * gegengeprüft: Bodo (eingeladen und gewählt) kommt hinein, Cleo (nicht
 * eingeladen) nicht.
 *
 * Die Termine werden per API angelegt, ohne Chatbindung – so gilt der Test
 * unverändert vor und nach der Einladungsarbeit.
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
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

const als = (sitzung: Sitzung) => ({ authorization: `Bearer ${sitzung.accessToken}` });

interface Sammlung {
  id: string;
  name: string;
  parentId: string | null;
  myLevel: string;
}

async function sammlungAnlegen(
  http: APIRequestContext,
  wer: Sitzung,
  name: string,
  parentId?: string,
): Promise<Sammlung> {
  const antwort = await http.post(`${API}/collections`, {
    headers: als(wer),
    data: { name, ...(parentId ? { parentId } : {}) },
  });
  expect(
    antwort.ok(),
    `Sammlung „${name}“: ${antwort.status()} ${await antwort.text()}`,
  ).toBeTruthy();
  return antwort.json();
}

async function freigeben(
  http: APIRequestContext,
  besitzer: Sitzung,
  sammlung: Sammlung,
  an: Sitzung,
  level: 'view' | 'edit',
) {
  const antwort = await http.post(`${API}/collections/${sammlung.id}/grants`, {
    headers: als(besitzer),
    data: { userId: an.user.id, level },
  });
  expect(antwort.ok(), `Freigabe: ${antwort.status()}`).toBeTruthy();
}

async function meineSammlungen(http: APIRequestContext, wer: Sitzung): Promise<Sammlung[]> {
  const antwort = await http.get(`${API}/collections`, { headers: als(wer) });
  return (await antwort.json()).items;
}

/** Ein Termin von `ersteller`, zu dem `eingeladene` gehören – ohne Chat. */
async function terminAnlegen(
  http: APIRequestContext,
  ersteller: Sitzung,
  eingeladene: Sitzung[],
): Promise<{ id: string; titel: string }> {
  const beginn = new Date();
  beginn.setDate(beginn.getDate() + 10);
  const titel = `Hüttenwochenende ${Math.random().toString(36).slice(2, 7)}`;
  const antwort = await http.post(`${API}/calendar/events`, {
    headers: als(ersteller),
    data: {
      title: titel,
      startsAt: beginn.toISOString(),
      endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
      attendeeIds: eingeladene.map((person) => person.user.id),
    },
  });
  const termin = await antwort.json();
  expect(termin.id, `Termin: ${JSON.stringify(termin)}`).toBeTruthy();
  return { id: termin.id, titel };
}

async function terminOeffnen(page: Page, wurzel: string, id: string) {
  await page.goto(`${wurzel}/kalender/termin/${id}`);
  await expect(page.getByRole('heading', { name: 'Sammlung', exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

async function blattOeffnen(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /Neue Sammlung anlegen/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Neue Sammlung' });
  await expect(blatt).toBeVisible();
  return blatt;
}

const anlegenKnopf = (blatt: Locator) =>
  blatt.getByRole('button', { name: 'Anlegen und verknüpfen' });

async function zugriff(
  http: APIRequestContext,
  wer: Sitzung,
  id: string,
): Promise<{ status: number; stufe?: string }> {
  const antwort = await http.get(`${API}/collections/${id}`, { headers: als(wer) });
  return {
    status: antwort.status(),
    stufe: antwort.ok() ? (await antwort.json()).myLevel : undefined,
  };
}

test.describe('Sammlung zum Termin: neu anlegen', () => {
  test('neu im Unterordner – die Eingeladenen kommen hinein', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const cleo = await registrieren(http, 'tsc');
    const familie = await sammlungAnlegen(http, anna, 'Familie');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);

    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);
    const blatt = await blattOeffnen(annaPage);

    // Der Titel steht schon im Namensfeld, Bodo ist angehakt, Cleo gibt es nicht.
    await expect(blatt.getByLabel('Name', { exact: true })).toHaveValue(titel);
    await expect(blatt.getByRole('checkbox', { name: bodo.user.displayName })).toBeChecked();
    await expect(blatt.getByRole('checkbox', { name: cleo.user.displayName })).toHaveCount(0);

    await blatt.getByRole('radio', { name: 'Familie', exact: true }).check();
    await expect(blatt.getByText('Ausser dir bekommt 1 Person Zugriff')).toBeVisible();
    await anlegenKnopf(blatt).click();

    const knopf = annaPage.getByRole('link', { name: `Familie › ${titel}` });
    await expect(knopf).toBeVisible({ timeout: 15_000 });
    await expect(blatt).toBeHidden();
    await expect(annaPage.getByText('Die eingeladene Person kommt hinein.')).toBeVisible();

    // An der API: Unterordner von „Familie“, Anna Besitzerin, Bodo ändert, Cleo sieht nichts.
    const neu = (await meineSammlungen(http, anna)).find((eintrag) => eintrag.name === titel);
    expect(neu?.parentId).toBe(familie.id);
    expect(neu?.myLevel).toBe('own');
    expect(await zugriff(http, bodo, neu!.id)).toEqual({ status: 200, stufe: 'edit' });
    expect((await zugriff(http, cleo, neu!.id)).status).toBe(404);

    // Bodos Termin zeigt den Knopf – für ihn ohne „Familie“, die er nicht sieht.
    const bodoPage = await seiteFuer(browser, bodo, wurzel);
    await bodoPage.goto(`${wurzel}/kalender/termin/${id}`);
    const bodosKnopf = bodoPage.getByRole('link', { name: `… › ${titel}` });
    await expect(bodosKnopf).toBeVisible({ timeout: 15_000 });
    await bodosKnopf.click();
    await expect(bodoPage.getByRole('heading', { name: titel })).toBeVisible({ timeout: 15_000 });

    await http.dispose();
    await annaPage.context().close();
    await bodoPage.context().close();
  });

  test('oberste Ebene: „nur ansehen“ gilt, ohne Haken kommt niemand hinein', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);

    // Erster Termin: Stufe „nur ansehen“.
    const eins = await terminAnlegen(http, anna, [bodo]);
    await terminOeffnen(annaPage, wurzel, eins.id);
    let blatt = await blattOeffnen(annaPage);
    await blatt.getByRole('radio', { name: 'ansehen', exact: true }).check();
    await expect(blatt.getByText('Zugriff (ansehen): ')).toBeVisible();
    await anlegenKnopf(blatt).click();
    await expect(annaPage.getByRole('link', { name: eins.titel })).toBeVisible({ timeout: 15_000 });
    const sammlungEins = (await meineSammlungen(http, anna)).find((e) => e.name === eins.titel);
    expect(sammlungEins?.parentId).toBeNull();
    expect(await zugriff(http, bodo, sammlungEins!.id)).toEqual({ status: 200, stufe: 'view' });

    // Zweiter Termin: der Haken bei Bodo fällt weg.
    const zwei = await terminAnlegen(http, anna, [bodo]);
    await terminOeffnen(annaPage, wurzel, zwei.id);
    blatt = await blattOeffnen(annaPage);
    await blatt.getByRole('checkbox', { name: bodo.user.displayName }).uncheck();
    await expect(blatt.getByText('Nur du hast Zugriff.')).toBeVisible();
    await anlegenKnopf(blatt).click();
    await expect(annaPage.getByRole('link', { name: zwei.titel })).toBeVisible({ timeout: 15_000 });

    const sammlungZwei = (await meineSammlungen(http, anna)).find((e) => e.name === zwei.titel);
    expect((await zugriff(http, bodo, sammlungZwei!.id)).status).toBe(404);
    // Der Abschnitt sagt, wer nicht hineinkommt – und bietet das Nachholen an.
    await expect(
      annaPage.getByText(`Die eingeladene Person kommt nicht hinein: ${bodo.user.displayName}.`),
    ).toBeVisible();
    await expect(annaPage.getByRole('button', { name: 'Freigeben …' })).toBeVisible();

    await http.dispose();
    await annaPage.context().close();
  });

  test('Ordnerwahl: nur Änderbares wählbar, die achte Ebene ist zu tief', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');

    // Bodos Ordner: „Bodos“ nur ansehen, darunter „Offen“ mit „ändern“ für Anna;
    // ein weiterer Ordner nur zum Ansehen ohne änderbares Kind.
    const bodos = await sammlungAnlegen(http, bodo, 'Bodos');
    await freigeben(http, bodo, bodos, anna, 'view');
    const offen = await sammlungAnlegen(http, bodo, 'Offen', bodos.id);
    await freigeben(http, bodo, offen, anna, 'edit');
    const nurAnsehen = await sammlungAnlegen(http, bodo, 'Nur zum Lesen');
    await freigeben(http, bodo, nurAnsehen, anna, 'view');

    // Eine Kette von acht Ebenen.
    let eltern: string | undefined;
    const kette: Sammlung[] = [];
    for (let ebene = 1; ebene <= 8; ebene += 1) {
      const glied = await sammlungAnlegen(http, anna, `Tiefe ${ebene}`, eltern);
      kette.push(glied);
      eltern = glied.id;
    }

    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);
    const blatt = await blattOeffnen(annaPage);

    const gruppe = blatt.getByRole('radiogroup', { name: 'Wo soll sie liegen?' });
    const bodosZeile = gruppe.getByRole('radio', { name: /^Bodos/ });
    await expect(bodosZeile).toBeDisabled();
    await expect(gruppe.getByText('nur ansehen')).toHaveCount(1);
    await expect(gruppe.getByRole('radio', { name: /^Offen/ })).toBeEnabled();
    await expect(gruppe.getByRole('radio', { name: /^Nur zum Lesen/ })).toHaveCount(0);

    // Die achte Ebene ist „zu tief“ (ein Kind wäre die neunte), die siebte nicht.
    const achte = gruppe.getByRole('radio', { name: /^Tiefe 8/ });
    await expect(achte).toBeDisabled();
    await expect(gruppe.getByText('zu tief')).toHaveCount(1);
    await expect(blatt.getByText('Mehr als 8 Ebenen sind nicht vorgesehen.')).toBeVisible();

    const siebte = gruppe.getByRole('radio', { name: /^Tiefe 7/ });
    await expect(siebte).toBeEnabled();
    await siebte.check();
    await anlegenKnopf(blatt).click();

    await expect(annaPage.getByRole('link', { name: new RegExp(titel) })).toBeVisible({
      timeout: 15_000,
    });
    const neu = (await meineSammlungen(http, anna)).find((eintrag) => eintrag.name === titel);
    expect(neu?.parentId).toBe(kette[6]?.id);

    await http.dispose();
    await annaPage.context().close();
  });

  test('geerbter Zugriff aus dem Ordner steht im Blatt', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const cleo = await registrieren(http, 'tsc');
    const familie = await sammlungAnlegen(http, anna, 'Familie');
    await freigeben(http, anna, familie, cleo, 'view');

    const { id } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);
    const blatt = await blattOeffnen(annaPage);

    await blatt.getByRole('radio', { name: 'Familie', exact: true }).check();
    await expect(blatt.getByTestId('geerbter-zugriff')).toContainText(
      `${cleo.user.displayName} (ansehen)`,
    );

    await http.dispose();
    await annaPage.context().close();
  });
});

test.describe('Sammlung zum Termin: Fehlerfälle', () => {
  /** Beantwortet das Verknüpfen mit einer Absage des Servers. */
  async function verknuepfenAblehnen(page: Page) {
    await page.route('**/api/v1/calendar/events/*/collection', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'forbidden', message: 'Nur der Ersteller darf das.' },
        }),
      });
    });
  }

  test('Verknüpfen abgelehnt – die neue Sammlung wird wieder entfernt', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);
    await verknuepfenAblehnen(annaPage);

    const blatt = await blattOeffnen(annaPage);
    await anlegenKnopf(blatt).click();

    await expect(
      blatt.getByText(
        'Das Verknüpfen hat nicht geklappt: Nur der Ersteller darf das. Die neue Sammlung wurde wieder entfernt.',
      ),
    ).toBeVisible({ timeout: 15_000 });
    // Das Blatt bleibt mit den Eingaben stehen.
    await expect(blatt.getByLabel('Name', { exact: true })).toHaveValue(titel);
    expect((await meineSammlungen(http, anna)).map((eintrag) => eintrag.name)).not.toContain(titel);

    await http.dispose();
    await annaPage.context().close();
  });

  test('ohne Netz beim Verknüpfen – kein Doppeltes, „Erneut verknüpfen“ klappt', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    const verknuepfen = '**/api/v1/calendar/events/*/collection';
    await annaPage.route(verknuepfen, (route) =>
      route.request().method() === 'PATCH' ? route.abort() : route.continue(),
    );

    const blatt = await blattOeffnen(annaPage);
    await anlegenKnopf(blatt).click();
    await expect(
      blatt.getByText(`„${titel}“ ist angelegt, aber noch nicht mit dem Termin verknüpft`),
    ).toBeVisible({ timeout: 15_000 });
    // Nichts wurde geräumt, und ein zweites „Anlegen“ gibt es nicht mehr.
    await expect(anlegenKnopf(blatt)).toHaveCount(0);
    expect((await meineSammlungen(http, anna)).filter((e) => e.name === titel)).toHaveLength(1);

    await annaPage.unroute(verknuepfen);
    await blatt.getByRole('button', { name: 'Erneut verknüpfen' }).click();
    await expect(annaPage.getByRole('link', { name: titel })).toBeVisible({ timeout: 15_000 });
    await expect(blatt).toBeHidden();
    expect((await meineSammlungen(http, anna)).filter((e) => e.name === titel)).toHaveLength(1);

    await http.dispose();
    await annaPage.context().close();
  });

  test('ohne Netz beim Verknüpfen – „Verwerfen“ räumt auf', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    await annaPage.route('**/api/v1/calendar/events/*/collection', (route) =>
      route.request().method() === 'PATCH' ? route.abort() : route.continue(),
    );
    const blatt = await blattOeffnen(annaPage);
    await anlegenKnopf(blatt).click();
    await expect(blatt.getByRole('button', { name: 'Verwerfen' })).toBeVisible({ timeout: 15_000 });

    await blatt.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(blatt.getByRole('button', { name: 'Verwerfen' })).toHaveCount(0);
    await expect
      .poll(async () => (await meineSammlungen(http, anna)).filter((e) => e.name === titel).length)
      .toBe(0);
    // Der Termin hängt an nichts.
    await expect(annaPage.getByRole('link', { name: new RegExp(titel) })).toHaveCount(0);

    await http.dispose();
    await annaPage.context().close();
  });

  test('Doppeltipp – es entsteht genau eine Sammlung', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    let posts = 0;
    annaPage.on('request', (anfrage) => {
      if (anfrage.method() === 'POST' && /\/api\/v1\/collections$/.test(anfrage.url())) posts += 1;
    });

    const blatt = await blattOeffnen(annaPage);
    // Zwei Absendungen im selben Augenblick, noch bevor React neu zeichnet –
    // genau das fängt ein bloßer `busy`-Zustand nicht ab.
    await blatt.locator('form').evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(annaPage.getByRole('link', { name: titel })).toBeVisible({ timeout: 15_000 });

    expect(posts).toBe(1);
    expect((await meineSammlungen(http, anna)).filter((e) => e.name === titel)).toHaveLength(1);

    await http.dispose();
    await annaPage.context().close();
  });

  test('ohne Netz beim Anlegen – das Blatt bleibt, der nächste Tipp klappt', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const { id, titel } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    const anlegen = '**/api/v1/collections';
    await annaPage.route(anlegen, (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    );
    const blatt = await blattOeffnen(annaPage);
    await blatt.getByLabel('Name', { exact: true }).fill(`${titel} (geändert)`);
    await anlegenKnopf(blatt).click();

    await expect(
      blatt.getByText('Keine Verbindung zum Server – es wurde nichts angelegt.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(blatt.getByLabel('Name', { exact: true })).toHaveValue(`${titel} (geändert)`);
    expect(await meineSammlungen(http, anna)).toHaveLength(0);

    await annaPage.unroute(anlegen);
    await anlegenKnopf(blatt).click();
    await expect(annaPage.getByRole('link', { name: `${titel} (geändert)` })).toBeVisible({
      timeout: 15_000,
    });

    await http.dispose();
    await annaPage.context().close();
  });

  test('leerer Name – Hinweis am Feld, kein Aufruf', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const { id } = await terminAnlegen(http, anna, []);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    let posts = 0;
    annaPage.on('request', (anfrage) => {
      if (anfrage.method() === 'POST' && /\/api\/v1\/collections$/.test(anfrage.url())) posts += 1;
    });
    const blatt = await blattOeffnen(annaPage);
    await blatt.getByLabel('Name', { exact: true }).fill('   ');
    await anlegenKnopf(blatt).click();

    await expect(blatt.getByText('Die Sammlung braucht einen Namen.')).toBeVisible();
    await expect(blatt.getByLabel('Name', { exact: true })).toBeFocused();
    expect(posts).toBe(0);
    // Ohne weitere Eingeladene sagt das Blatt das auch.
    await expect(blatt.getByText('Sonst ist noch niemand eingeladen.')).toBeVisible();

    await http.dispose();
    await annaPage.context().close();
  });
});

test.describe('Sammlung zum Termin: bestehende verknüpfen', () => {
  test('Auswahl mit Pfad und ohne Nur-ansehen; fehlender Zugriff lässt sich nachholen', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const familie = await sammlungAnlegen(http, anna, 'Familie');
    await sammlungAnlegen(http, anna, 'Urlaube', familie.id);
    const privat = await sammlungAnlegen(http, anna, 'Privat');
    const fremd = await sammlungAnlegen(http, bodo, 'Nur zum Lesen');
    await freigeben(http, bodo, fremd, anna, 'view');

    const { id } = await terminAnlegen(http, anna, [bodo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    const auswahl = annaPage.getByLabel('Bestehende Sammlung verknüpfen');
    await expect(auswahl.locator('option', { hasText: 'Familie › Urlaube' })).toHaveCount(1);
    await expect(auswahl.locator('option', { hasText: 'Nur zum Lesen' })).toHaveCount(0);

    await auswahl.selectOption({ label: 'Privat' });
    await expect(annaPage.getByRole('link', { name: 'Privat' })).toBeVisible({ timeout: 15_000 });
    await expect(
      annaPage.getByText(`Die eingeladene Person kommt nicht hinein: ${bodo.user.displayName}.`),
    ).toBeVisible();
    expect((await zugriff(http, bodo, privat.id)).status).toBe(404);

    await annaPage.getByRole('button', { name: 'Freigeben …' }).click();
    const teilen = annaPage.getByRole('dialog', { name: /teilen/ });
    await expect(teilen.getByRole('checkbox', { name: bodo.user.displayName })).toBeChecked();
    await teilen.getByRole('button', { name: /^Freigeben: / }).click();
    await expect(teilen.getByRole('button', { name: 'Zurücknehmen' })).toBeVisible({
      timeout: 15_000,
    });
    await annaPage.keyboard.press('Escape');

    await expect(annaPage.getByText('Die eingeladene Person kommt hinein.')).toBeVisible({
      timeout: 15_000,
    });
    expect(await zugriff(http, bodo, privat.id)).toEqual({ status: 200, stufe: 'view' });

    await http.dispose();
    await annaPage.context().close();
  });

  test('wer die Sammlung nicht besitzt, kann nicht freigeben – und es steht da', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const cleo = await registrieren(http, 'tsc');
    const bodos = await sammlungAnlegen(http, bodo, 'Bodos Sammlung');
    await freigeben(http, bodo, bodos, anna, 'edit');

    // Cleo ist eingeladen und kommt nicht hinein; Bodo gehört die Sammlung.
    const { id } = await terminAnlegen(http, anna, [cleo]);
    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);

    await annaPage
      .getByLabel('Bestehende Sammlung verknüpfen')
      .selectOption({ label: 'Bodos Sammlung' });
    await expect(
      annaPage.getByText(`Freigeben kann nur, wem die Sammlung gehört: ${bodo.user.displayName}.`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(annaPage.getByRole('button', { name: 'Freigeben …' })).toHaveCount(0);

    await http.dispose();
    await annaPage.context().close();
  });

  test('ein Eingeladener ohne Zugriff sieht den Hinweis, keinen toten Knopf', async ({
    browser,
    baseURL,
  }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const privat = await sammlungAnlegen(http, anna, 'Privat');
    const { id } = await terminAnlegen(http, anna, [bodo]);
    const verknuepft = await http.patch(`${API}/calendar/events/${id}/collection`, {
      headers: als(anna),
      data: { collectionId: privat.id },
    });
    expect(verknuepft.ok()).toBeTruthy();

    const wurzel = baseURL ?? 'http://localhost:5173';
    const bodoPage = await seiteFuer(browser, bodo, wurzel);
    await bodoPage.goto(`${wurzel}/kalender/termin/${id}`);
    await expect(
      bodoPage.getByText('Zu diesem Termin gehört eine Sammlung, die dir nicht freigegeben ist.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(bodoPage.getByText(`Frag ${anna.user.displayName}`)).toBeVisible();
    await expect(bodoPage.getByRole('link', { name: /Zur Sammlung|Privat/ })).toHaveCount(0);

    await http.dispose();
    await bodoPage.context().close();
  });

  test('Lösen – wer schon Zugriff bekam, behält ihn', async ({ browser, baseURL }) => {
    const http = await request.newContext();
    const anna = await registrieren(http, 'tsa');
    const bodo = await registrieren(http, 'tsb');
    const bilder = await sammlungAnlegen(http, anna, 'Bilder');
    await freigeben(http, anna, bilder, bodo, 'view');
    const { id } = await terminAnlegen(http, anna, [bodo]);
    expect(
      (
        await http.patch(`${API}/calendar/events/${id}/collection`, {
          headers: als(anna),
          data: { collectionId: bilder.id },
        })
      ).ok(),
    ).toBeTruthy();

    const wurzel = baseURL ?? 'http://localhost:5173';
    const annaPage = await seiteFuer(browser, anna, wurzel);
    await terminOeffnen(annaPage, wurzel, id);
    await expect(annaPage.getByRole('link', { name: 'Bilder' })).toBeVisible({ timeout: 15_000 });

    await annaPage.getByLabel('Bestehende Sammlung verknüpfen').selectOption({ label: 'Keine' });
    await expect(
      annaPage.getByText('Wer schon Zugriff bekam, behält ihn', { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(annaPage.getByRole('link', { name: 'Bilder' })).toHaveCount(0);
    expect(await zugriff(http, bodo, bilder.id)).toEqual({ status: 200, stufe: 'view' });

    await http.dispose();
    await annaPage.context().close();
  });
});
