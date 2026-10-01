import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Der Ort eines Termins als Adresse.
 *
 * Geprüft wird, was ein Eingeladener davon hat: Er öffnet die Detailansicht
 * oder die Chatkarte, tippt auf die Adresse, wählt SEINE Karten-App – und die
 * Links stimmen. Die Links werden nur gelesen (`href`), nie wirklich befolgt:
 * Fremde Hosts sind im Test abgefangen und abgebrochen, damit nichts Echtes
 * geladen wird. Dass es so bleibt, ist selbst eine Prüfung: Vor dem Tippen darf
 * keine einzige Anfrage an einen Karten-Anbieter gehen.
 *
 * Die Erkennung selbst (Hunderte Beispiele) steht in `lib/adresse.test.ts`.
 * Hier geht es um die Verdrahtung: Blatt, gemerkte Wahl, Einstellung,
 * Chatkarte, Tastatur und schmale Bildschirme.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

const ORT = 'Vereinsheim, Hauptstr. 5, 12345 Berlin';
/** Der Adresskern: das, was verlinkt wird und an die Karten-App geht. */
const KERN = 'Hauptstr. 5, 12345 Berlin';
const KERN_KODIERT = 'Hauptstr.%205%2C%2012345%20Berlin';

const KARTEN_HOSTS = /(^|\.)(google\.com|apple\.com|openstreetmap\.org|waze\.com|bing\.com)$/;
const SPEICHER = 'initiative.karten-app';

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

interface Anfrage {
  url: string;
  referer: string | null;
}

interface Zugang {
  page: Page;
  /** Alles, was die Seite an fremde Rechner schicken wollte (abgebrochen). */
  fremd: Anfrage[];
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

/**
 * Eine angemeldete Seite. Jeder Zugang ist ein eigener Browserkontext – also
 * auch ein eigener `localStorage`: Die Wahl der Karten-App gehört dem Gerät.
 */
async function zugang(
  browser: Browser,
  sitzung: Sitzung,
  wurzel: string,
  optionen: BrowserContextOptions = {},
): Promise<Zugang> {
  const context = await browser.newContext(optionen);
  const fremd: Anfrage[] = [];
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    async (route) => {
      const anfrage = route.request();
      fremd.push({ url: anfrage.url(), referer: await anfrage.headerValue('referer') });
      await route.abort();
    },
  );
  const page = await context.newPage();
  await page.goto(wurzel);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return { page, fremd };
}

interface Szenario {
  http: APIRequestContext;
  anna: Sitzung;
  bodo: Sitzung;
  gruppe: { id: string; title: string };
  wurzel: string;
  /** Legt über die API einen Termin im Gruppenchat an – Anna ist die Gastgeberin. */
  termin: (ort: string | null, titel?: string) => Promise<{ id: string; title: string }>;
}

async function szenario(baseURL: string | undefined): Promise<Szenario> {
  const http = await request.newContext();
  const anna = await registrieren(http, 'orta');
  const bodo = await registrieren(http, 'ortb');
  const alsAnna = { authorization: `Bearer ${anna.accessToken}` };
  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: alsAnna,
      data: { type: 'group', title: `Vereinsabend ${Date.now()}`, memberIds: [bodo.user.id] },
    })
  ).json();

  let zaehler = 0;
  async function termin(ort: string | null, titel?: string) {
    zaehler += 1;
    // Bewusst in den nächsten Tagen: Nur so weit reicht die Agenda.
    const beginn = new Date();
    beginn.setDate(beginn.getDate() + 2);
    beginn.setHours(18, zaehler % 50, 0, 0);
    const ende = new Date(beginn.getTime() + 3_600_000);
    const name = titel ?? `Treffen ${Date.now()}-${zaehler}`;
    const antwort = await http.post(`${API}/calendar/events`, {
      headers: alsAnna,
      data: {
        conversationId: gruppe.id,
        title: name,
        location: ort,
        startsAt: beginn.toISOString(),
        endsAt: ende.toISOString(),
      },
    });
    const angelegt = await antwort.json();
    expect(angelegt.id, `Termin angelegt: ${JSON.stringify(angelegt)}`).toBeTruthy();
    return { id: angelegt.id as string, title: name };
  }

  return { http, anna, bodo, gruppe, wurzel: baseURL ?? 'http://localhost:5173', termin };
}

/**
 * Bildschirmfotos zum Ansehen, nur auf Wunsch (`ORT_BILDER=/pfad`): Sie
 * gehören nicht in den Lauf und nicht ins Repo.
 */
async function bild(page: Page, name: string) {
  const ordner = process.env.ORT_BILDER;
  if (ordner) await page.screenshot({ path: `${ordner}/${name}.png` });
}

/**
 * Wartet, bis ein geschlossenes Blatt seinen Verlaufseintrag zurückgenommen
 * hat (`lib/dialogVerlauf.ts`). Ein Neuladen mitten in diesem `history.back()`
 * bricht mit `ERR_ABORTED` ab – im Test, nicht in der Bedienung.
 */
async function verlaufBereinigt(page: Page) {
  await page.waitForFunction(
    () =>
      !(window.history.state && (window.history.state as Record<string, unknown>).initiativeDialog),
  );
}

const gemerkt = (page: Page) => page.evaluate((key) => localStorage.getItem(key), SPEICHER);

const kartenAnfragen = (fremd: Anfrage[]) =>
  fremd.filter((anfrage) => KARTEN_HOSTS.test(new URL(anfrage.url).hostname));

/** Das offene Blatt „Öffnen mit“ (oder „Auf Karte suchen“). */
const blatt = (page: Page, titel = 'Öffnen mit') => page.getByRole('dialog', { name: titel });

/** Die Zeile einer App im Blatt, über den Namen am Anfang ihrer Beschriftung. */
const appLink = (dialog: Locator, name: string) =>
  dialog.getByRole('link', { name: new RegExp(`^${name}`) });

async function appNamen(dialog: Locator): Promise<string[]> {
  return dialog.locator('.karten-app-name').allInnerTexts();
}

test('Anna legt einen Termin mit Adresse an, Bodo sieht Karte und Chatkarte', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const anna = await zugang(browser, s.anna, s.wurzel);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  // ---- Anna tippt die Adresse und bekommt gesagt, was die App daraus macht ----
  await anna.page.goto(`${s.wurzel}/kalender`);
  await anna.page.getByRole('button', { name: /Neuer Termin/ }).click();
  const titel = `Sommerfest ${Date.now()}`;
  await anna.page.locator('#cal-title').fill(titel);

  const ortFeld = anna.page.locator('#cal-location');
  const hinweis = anna.page.locator('#cal-location-hint');
  await expect(ortFeld).toHaveAttribute('aria-describedby', 'cal-location-hint');
  await expect(hinweis).toContainText('Mit Straße, Hausnummer und Ort lässt sich der Ort');

  // Mitten im Tippen: noch keine Adresse – und der Hinweis sagt es ehrlich.
  await ortFeld.fill('Hauptstr');
  await expect(hinweis).toContainText('Keine Adresse erkannt');
  await ortFeld.fill(ORT);
  await expect(hinweis).toHaveText(
    'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
  );

  await anna.page.locator('#cal-conversation').selectOption({ label: s.gruppe.title });
  await anna.page.getByRole('button', { name: 'Termin erstellen' }).click();
  await expect(anna.page.getByText('Termin erstellt')).toBeVisible({ timeout: 15_000 });

  // ---- Bodo sieht die Karte im Chat – die Adresse ist ein eigener Knopf ----
  await bodo.page.goto(`${s.wurzel}/chats/${s.gruppe.id}`);
  const karte = bodo.page.locator('.cal-bubble').filter({ hasText: titel });
  await expect(karte).toBeVisible({ timeout: 15_000 });
  await expect(karte.getByText('Vereinsheim,')).toBeVisible();
  const adresse = karte.getByRole('button', { name: KERN, exact: true });
  await expect(adresse).toBeVisible();

  // Kein Link im Link: Die Adresse steht UNTER dem Kartenkopf, nicht darin.
  await expect(karte.locator('a a')).toHaveCount(0);
  await expect(karte.locator('.cal-bubble-head .ort')).toHaveCount(0);
  await expect(karte.locator('.cal-bubble-head')).toHaveJSProperty('tagName', 'A');

  // Der Tipp auf die Adresse öffnet das Blatt und navigiert NICHT.
  await adresse.click();
  const dialog = blatt(bodo.page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.karten-ziel')).toHaveText(KERN);
  await expect(bodo.page).toHaveURL(new RegExp(`/chats/${s.gruppe.id}$`));
  await bodo.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Der Tipp auf den Kartenkopf führt weiter zum Termin.
  await karte.locator('.cal-bubble-head').click();
  await expect(bodo.page).toHaveURL(/\/kalender\/termin\//);

  // ---- Und in der Detailansicht steht dieselbe Adresse als Knopf ----
  const detail = bodo.page.locator('.cal-detail-facts');
  await expect(detail.getByText('Vereinsheim,')).toBeVisible();
  await expect(detail.getByRole('button', { name: KERN, exact: true })).toBeVisible();

  // Bis hierher hat die App an keinen Karten-Anbieter geschrieben.
  expect(kartenAnfragen(bodo.fremd)).toEqual([]);
  expect(kartenAnfragen(anna.fremd)).toEqual([]);

  await s.http.dispose();
  await anna.page.context().close();
  await bodo.page.context().close();
});

test('Detailansicht: Blatt, Links, OpenStreetMap ohne Referer, Wahl wird gemerkt', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  const adresse = bodo.page.getByRole('button', { name: KERN, exact: true });
  await expect(adresse).toBeVisible({ timeout: 15_000 });
  // Der Name davor bleibt Text und ist nicht Teil des Knopfes.
  await expect(bodo.page.locator('.cal-detail-facts')).toContainText('Vereinsheim,');
  await expect(bodo.page.locator('.cal-detail-facts a[href*="google"]')).toHaveCount(0);
  expect(kartenAnfragen(bodo.fremd)).toEqual([]);

  // ---- Das Blatt ----
  await adresse.click();
  const dialog = blatt(bodo.page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.karten-ziel')).toHaveText(KERN);

  const modus = dialog.getByRole('group', { name: 'Was soll geöffnet werden?' });
  await expect(modus.getByRole('button', { name: 'Karte zeigen' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(modus.getByRole('button', { name: 'Route hierher' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Desktop (Chromium unter Linux): weder Apple Karten noch die Standard-Karten-App.
  expect(await appNamen(dialog)).toEqual(['Google Maps', 'OpenStreetMap', 'Bing Karten', 'Waze']);
  await expect(appLink(dialog, 'Apple Karten')).toHaveCount(0);
  await expect(appLink(dialog, 'Standard-Karten-App')).toHaveCount(0);

  const hrefs = {
    google: `https://www.google.com/maps/search/?api=1&query=${KERN_KODIERT}`,
    osm: `https://www.openstreetmap.org/search?query=${KERN_KODIERT}`,
    bing: `https://bing.com/maps/default.aspx?where1=${KERN_KODIERT}`,
    waze: `https://waze.com/ul?q=${KERN_KODIERT}`,
  };
  await expect(appLink(dialog, 'Google Maps')).toHaveAttribute('href', hrefs.google);
  await expect(appLink(dialog, 'OpenStreetMap')).toHaveAttribute('href', hrefs.osm);
  await expect(appLink(dialog, 'Bing Karten')).toHaveAttribute('href', hrefs.bing);
  await expect(appLink(dialog, 'Waze')).toHaveAttribute('href', hrefs.waze);
  // Jeder Link geht in ein neues Fenster und gibt weder Herkunft noch Fenster preis.
  for (const name of ['Google Maps', 'OpenStreetMap', 'Bing Karten', 'Waze']) {
    const link = appLink(dialog, name);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }

  // ---- Route: nur, was per Link zur Route aufgefordert werden kann ----
  await modus.getByRole('button', { name: 'Route hierher' }).click();
  await expect(dialog.getByText('Nicht jede App lässt sich per Link zu einer Route')).toBeVisible();
  // OpenStreetMap kann bei Text keine Route.
  expect(await appNamen(dialog)).toEqual(['Google Maps', 'Bing Karten', 'Waze']);
  await expect(appLink(dialog, 'Google Maps')).toHaveAttribute(
    'href',
    `https://www.google.com/maps/dir/?api=1&destination=${KERN_KODIERT}`,
  );
  await expect(appLink(dialog, 'Waze')).toHaveAttribute(
    'href',
    `https://waze.com/ul?q=${KERN_KODIERT}&navigate=yes`,
  );
  await expect(appLink(dialog, 'Bing Karten')).toHaveAttribute(
    'href',
    `https://bing.com/maps/default.aspx?rtp=~adr.${KERN_KODIERT}`,
  );
  await modus.getByRole('button', { name: 'Karte zeigen' }).click();
  expect(await appNamen(dialog)).toHaveLength(4);

  // ---- Alles andere im Blatt ----
  await expect(dialog.getByRole('button', { name: 'Adresse kopieren' })).toBeVisible();
  await expect(dialog.getByLabel('Diese Wahl merken')).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Jedes Mal fragen' })).toHaveCount(0);
  await expect(dialog).toContainText(
    'Beim Öffnen geht die Adresse an die gewählte Karten-App und deren Anbieter. Initiative selbst lädt keine Karte und schickt nichts, bevor du tippst.',
  );
  await expect(
    dialog.getByRole('link', { name: 'Karten-App ändern: Profil → Einstellungen' }),
  ).toBeVisible();
  // Noch immer nichts an Dritte: Das Blatt zeigt nur Links.
  expect(kartenAnfragen(bodo.fremd)).toEqual([]);

  // ---- OpenStreetMap: öffnet ein neues Fenster, ohne Referer, das Blatt geht zu ----
  const [fenster] = await Promise.all([
    bodo.page.context().waitForEvent('page'),
    appLink(dialog, 'OpenStreetMap').click(),
  ]);
  await expect.poll(() => kartenAnfragen(bodo.fremd).length, { timeout: 10_000 }).toBe(1);
  const gesendet = kartenAnfragen(bodo.fremd)[0];
  expect(gesendet.url).toBe(hrefs.osm);
  // Ohne `noreferrer` ginge hier unsere Herkunft an die Karten-App.
  expect(gesendet.referer).toBeNull();
  await fenster.close();
  await expect(dialog).toBeHidden();
  expect(await gemerkt(bodo.page)).toBe('osm');

  // ---- Wahl gemerkt: Neuladen, die Adresse ist jetzt ein echter Link ----
  await bodo.page.reload();
  const link = bodo.page.locator('.cal-detail-facts a.ort-link');
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(link).toHaveAttribute('href', hrefs.osm);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  await expect(link).toContainText(KERN);
  // Für die Vorlesehilfe: wohin der Link führt.
  await expect(link.locator('.visually-hidden')).toHaveText(' – öffnet in OpenStreetMap');
  await expect(bodo.page.getByRole('button', { name: KERN, exact: true })).toHaveCount(0);

  // Der Tipp öffnet direkt (kein Blatt).
  const [direkt] = await Promise.all([bodo.page.context().waitForEvent('page'), link.click()]);
  await direkt.close();
  await expect(blatt(bodo.page)).toHaveCount(0);

  // „⋯“ öffnet das Blatt trotzdem, mit der gemerkten App als Standard.
  const mehr = bodo.page.getByRole('button', {
    name: 'Mit anderer Karten-App oder als Route öffnen',
  });
  await mehr.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.karten-app[aria-current="true"]')).toContainText(
    'OpenStreetMap · Standard',
  );

  // „Jedes Mal fragen“ stellt den Zustand zurück – sofort, auch hinter dem Blatt.
  await dialog.getByRole('button', { name: 'Jedes Mal fragen' }).click();
  expect(await gemerkt(bodo.page)).toBeNull();
  await expect(bodo.page.locator('.cal-detail-facts a.ort-link')).toHaveCount(0);
  await bodo.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await bodo.page.getByRole('button', { name: KERN, exact: true }).click();
  await expect(dialog).toBeVisible();

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Wahl nicht merken: der nächste Tipp fragt wieder', async ({ browser, baseURL }) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await bodo.page.getByRole('button', { name: KERN, exact: true }).click();
  const dialog = blatt(bodo.page);
  await dialog.getByLabel('Diese Wahl merken').uncheck();
  const [fenster] = await Promise.all([
    bodo.page.context().waitForEvent('page'),
    appLink(dialog, 'Google Maps').click(),
  ]);
  await fenster.close();
  await expect(dialog).toBeHidden();
  expect(await gemerkt(bodo.page)).toBeNull();
  // Weiterhin ein Knopf: Es wurde nichts gemerkt.
  await expect(bodo.page.getByRole('button', { name: KERN, exact: true })).toBeVisible();

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Einstellung „Karten-App“: Wahl gilt im Termin, Änderung im Blatt wirkt in der Einstellung', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  await bodo.page.goto(`${s.wurzel}/profil/einstellungen#karten-app`);
  const gruppe = bodo.page.getByRole('radiogroup', { name: 'Karten-App' });
  await expect(gruppe).toBeVisible({ timeout: 15_000 });
  // Desktop: Jedes Mal fragen (Vorgabe), Google Maps, OpenStreetMap, Bing Karten, Waze.
  await expect(gruppe.getByRole('radio')).toHaveCount(5);
  await expect(gruppe.getByRole('radio', { name: /^Jedes Mal fragen/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(gruppe.getByRole('radio', { name: /^Apple Karten/ })).toHaveCount(0);
  await expect(gruppe.getByRole('radio', { name: /^Standard-Karten-App/ })).toHaveCount(0);
  // Datenschutzhinweis und Verweis auf die Erklärung.
  const karte = bodo.page.locator('#karten-app');
  await expect(karte).toContainText('Initiative selbst lädt keine Karte');
  await expect(karte.getByRole('link', { name: 'Datenschutzerklärung' })).toBeVisible();

  // Waze wählen: Es steht im Speicher, und der Link im Termin führt dorthin.
  await gruppe.getByRole('radio', { name: /^Waze/ }).click();
  await expect(gruppe.getByRole('radio', { name: /^Waze/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(gruppe.getByRole('radio', { name: /^Jedes Mal fragen/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(await gemerkt(bodo.page)).toBe('waze');

  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  const link = bodo.page.locator('.cal-detail-facts a.ort-link');
  await expect(link).toHaveAttribute('href', `https://waze.com/ul?q=${KERN_KODIERT}`, {
    timeout: 15_000,
  });

  // Im Blatt „Jedes Mal fragen“: Der Verweis führt (ohne Neuladen) in die Einstellung zurück.
  await bodo.page
    .getByRole('button', { name: 'Mit anderer Karten-App oder als Route öffnen' })
    .click();
  const dialog = blatt(bodo.page);
  await dialog.getByRole('button', { name: 'Jedes Mal fragen' }).click();
  await dialog.getByRole('link', { name: 'Karten-App ändern: Profil → Einstellungen' }).click();
  await expect(bodo.page).toHaveURL(/\/profil\/einstellungen#karten-app$/);
  await expect(dialog).toBeHidden();
  await expect(
    bodo.page
      .getByRole('radiogroup', { name: 'Karten-App' })
      .getByRole('radio', { name: /^Jedes Mal fragen/ }),
  ).toHaveAttribute('aria-checked', 'true');

  // Pfeiltasten wählen wie in jeder Radiogruppe.
  await bodo.page
    .getByRole('radiogroup', { name: 'Karten-App' })
    .getByRole('radio', { name: /^Jedes Mal fragen/ })
    .focus();
  await bodo.page.keyboard.press('ArrowDown');
  expect(await gemerkt(bodo.page)).toBe('google');
  await bodo.page.keyboard.press('ArrowUp');
  expect(await gemerkt(bodo.page)).toBeNull();

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Chatkarte: Anna und Bodo wählen unabhängig voneinander', async ({ browser, baseURL }) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const anna = await zugang(browser, s.anna, s.wurzel);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  for (const person of [anna, bodo]) {
    await person.page.goto(`${s.wurzel}/chats/${s.gruppe.id}`);
    const karte = person.page.locator('.cal-bubble').filter({ hasText: termin.title });
    await expect(karte).toBeVisible({ timeout: 15_000 });
    await expect(karte.getByRole('button', { name: KERN, exact: true })).toBeVisible();
    await expect(karte.locator('a a')).toHaveCount(0);
  }

  // Bodo wählt Waze und merkt es.
  const bodoKarte = bodo.page.locator('.cal-bubble').filter({ hasText: termin.title });
  await bodoKarte.getByRole('button', { name: KERN, exact: true }).click();
  const bodoBlatt = blatt(bodo.page);
  const [wazeFenster] = await Promise.all([
    bodo.page.context().waitForEvent('page'),
    appLink(bodoBlatt, 'Waze').click(),
  ]);
  await wazeFenster.close();
  await expect(bodoBlatt).toBeHidden();

  // Anna wählt Google Maps und merkt es.
  const annaKarte = anna.page.locator('.cal-bubble').filter({ hasText: termin.title });
  await annaKarte.getByRole('button', { name: KERN, exact: true }).click();
  const annaBlatt = blatt(anna.page);
  const [googleFenster] = await Promise.all([
    anna.page.context().waitForEvent('page'),
    appLink(annaBlatt, 'Google Maps').click(),
  ]);
  await googleFenster.close();
  await expect(annaBlatt).toBeHidden();

  // Jeder sieht SEINEN Link – auf der Chatkarte, und er ist ein echter Link.
  const bodoLink = bodoKarte.locator('a.ort-link');
  const annaLink = annaKarte.locator('a.ort-link');
  await expect(bodoLink).toHaveAttribute('href', `https://waze.com/ul?q=${KERN_KODIERT}`);
  await expect(annaLink).toHaveAttribute(
    'href',
    `https://www.google.com/maps/search/?api=1&query=${KERN_KODIERT}`,
  );
  expect(await gemerkt(bodo.page)).toBe('waze');
  expect(await gemerkt(anna.page)).toBe('google');
  // Weiterhin kein Link im Link, und der Kartenkopf führt zum Termin.
  await expect(bodoKarte.locator('a a')).toHaveCount(0);
  await bodoKarte.locator('.cal-bubble-head').click();
  await expect(bodo.page).toHaveURL(new RegExp(`/kalender/termin/${termin.id}$`));

  await s.http.dispose();
  await anna.page.context().close();
  await bodo.page.context().close();
});

test('Agenda: die Zeile bleibt ein einziger Link zum Termin, der Ort ist Text', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  await bodo.page.goto(`${s.wurzel}/kalender`);
  await bodo.page.getByRole('tab', { name: 'Agenda' }).click();
  const zeile = bodo.page.locator('a.cal-row').filter({ hasText: termin.title });
  await expect(zeile).toHaveCount(1, { timeout: 15_000 });
  await expect(zeile.locator('.cal-row-meta')).toContainText(ORT);
  // Verschachtelte Links gibt es nicht, und kein Ort-Element in der Zeile.
  await expect(zeile.locator('a, button, .ort')).toHaveCount(0);

  await zeile.click();
  await expect(bodo.page).toHaveURL(new RegExp(`/kalender/termin/${termin.id}$`));

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Orte ohne Adresse: Suchangebot, kein Kartenelement, Web-Link in den Browser', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const park = await s.termin('Stadtpark, Eingang Nord');
  const zoom = await s.termin('Zoom');
  const online = await s.termin('Online');
  const link = await s.termin('https://zoom.us/j/123456789?pwd=abc');
  const gemischt = await s.termin('Zoom: https://zoom.us/j/123456789');
  const bodo = await zugang(browser, s.bodo, s.wurzel);
  const fakten = bodo.page.locator('.cal-detail-facts');

  // ---- Stadtpark, Eingang Nord: Text und gedämpftes „Auf Karte suchen“ ----
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${park.id}`);
  await expect(fakten).toContainText('Stadtpark, Eingang Nord', { timeout: 15_000 });
  await expect(fakten.locator('.ort-link')).toHaveCount(0);
  const suchen = fakten.getByRole('button', { name: 'Auf Karte suchen' });
  await expect(suchen).toBeVisible();
  await suchen.click();
  const dialog = blatt(bodo.page, 'Auf Karte suchen');
  await expect(dialog).toBeVisible();
  // Das Beiwerk fällt weg, und das Blatt warnt.
  await expect(dialog.locator('.karten-ziel')).toHaveText('Stadtpark');
  await expect(dialog).toContainText(
    'Das sieht nicht nach einer Adresse aus. Die Suche kann ins Leere laufen.',
  );
  await expect(appLink(dialog, 'Google Maps')).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=Stadtpark',
  );
  await bodo.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // ---- Zoom, Online: ein Wort, kein Kartenelement ----
  for (const [termin, wort] of [
    [zoom, 'Zoom'],
    [online, 'Online'],
  ] as const) {
    await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
    await expect(fakten).toContainText(wort, { timeout: 15_000 });
    await expect(fakten.locator('.ort-link, .ort-suchen, .ort-mehr')).toHaveCount(0);
  }

  // ---- Nur ein Link: Browser, nie ein Kartenelement ----
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${link.id}`);
  const zoomLink = fakten.locator('a.ort-link');
  await expect(zoomLink).toBeVisible({ timeout: 15_000 });
  await expect(zoomLink).toHaveAttribute('href', 'https://zoom.us/j/123456789?pwd=abc');
  await expect(zoomLink).toHaveAttribute('target', '_blank');
  await expect(zoomLink).toHaveAttribute('rel', /noopener/);
  await expect(zoomLink).toHaveAttribute('rel', /noreferrer/);
  await expect(zoomLink).toHaveText('zoom.us/j/123456789');
  await expect(fakten.locator('button.ort-link, .ort-suchen, .ort-mehr')).toHaveCount(0);
  await expect(fakten.locator('.ort-symbol')).toHaveText('🔗');

  // ---- „Zoom: Link“: Text und Link, keine Karte ----
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${gemischt.id}`);
  await expect(fakten.locator('a.ort-link')).toBeVisible({ timeout: 15_000 });
  await expect(fakten.locator('.ort-text')).toContainText('Zoom:');
  await expect(fakten.locator('button.ort-link, .ort-suchen')).toHaveCount(0);

  // Nichts davon hat einen Karten-Anbieter angefragt.
  expect(kartenAnfragen(bodo.fremd)).toEqual([]);

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Hinweis unter dem Ortsfeld: Termin, Terminfindung, Umfrage zu Termin', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(null);
  const anna = await zugang(browser, s.anna, s.wurzel);

  // ---- Termin bearbeiten ----
  await anna.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await anna.page.getByRole('button', { name: 'Termin bearbeiten', exact: true }).click();
  const feld = anna.page.locator('#cal-location');
  const hinweis = anna.page.locator('#cal-location-hint');
  await expect(feld).toHaveAttribute('aria-describedby', 'cal-location-hint');
  const faelle: [string, string | null][] = [
    ['', 'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.'],
    [
      'Hauptstr. 5, 12345 Berlin',
      'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
    ],
    [
      'An der Alster 12',
      'Sieht nach einer Adresse aus. Mit Postleitzahl und Ort findet die Karte sie genauer.',
    ],
    [
      '12345 Berlin',
      'Nur Postleitzahl und Ort erkannt. Mit Straße und Hausnummer landet die Karte genau am Ziel.',
    ],
    [
      '48.13743, 11.57549',
      'Koordinaten erkannt: Wer eingeladen ist, kann die Stelle in seiner Karten-App öffnen.',
    ],
    ['https://zoom.us/j/123', 'Link erkannt: Wer eingeladen ist, kann ihn antippen.'],
    [
      'Stadtpark, Eingang Nord',
      'Keine Adresse erkannt. Wer eingeladen ist, kann den Ort trotzdem auf der Karte suchen.',
    ],
    ['Zoom', null],
    ['', 'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.'],
  ];
  for (const [eingabe, erwartet] of faelle) {
    await feld.fill(eingabe);
    if (erwartet === null) await expect(hinweis).toBeHidden();
    else await expect(hinweis).toHaveText(erwartet);
  }
  await feld.fill('Hauptstr. 5, 12345 Berlin');
  await expect(hinweis).toHaveClass(/cal-hint-ok/);
  await feld.fill('12345 Berlin');
  await expect(hinweis).not.toHaveClass(/cal-hint-ok/);
  await anna.page.keyboard.press('Escape');
  await verlaufBereinigt(anna.page);

  // ---- Terminfindung (Kalender → Abstimmen) ----
  await anna.page.goto(`${s.wurzel}/kalender`);
  await anna.page.getByRole('button', { name: /Abstimmen/ }).click();
  const planFeld = anna.page.locator('#plan-location');
  await expect(planFeld).toHaveAttribute('aria-describedby', 'plan-location-hint');
  await planFeld.fill('Hauptstr. 5, 12345 Berlin');
  await expect(anna.page.locator('#plan-location-hint')).toContainText('Adresse erkannt');
  await planFeld.fill('12345 Berlin');
  await expect(anna.page.locator('#plan-location-hint')).toContainText(
    'Nur Postleitzahl und Ort erkannt',
  );
  await anna.page.keyboard.press('Escape');
  await verlaufBereinigt(anna.page);

  // ---- Umfrage zu Termin: Terminfindung im Chat, dann „Termin erstellen“ ----
  const morgen = new Date();
  morgen.setDate(morgen.getDate() + 3);
  const frueh = new Date(morgen);
  frueh.setHours(18, 0, 0, 0);
  const spaet = new Date(morgen);
  spaet.setHours(19, 0, 0, 0);
  const umfrage = await s.http.post(`${API}/polls`, {
    headers: { authorization: `Bearer ${s.anna.accessToken}` },
    data: {
      conversationId: s.gruppe.id,
      kind: 'date',
      question: `Wann treffen wir uns ${Date.now()}?`,
      options: [
        {
          startsAt: frueh.toISOString(),
          endsAt: new Date(frueh.getTime() + 3_600_000).toISOString(),
        },
        {
          startsAt: spaet.toISOString(),
          endsAt: new Date(spaet.getTime() + 3_600_000).toISOString(),
        },
      ],
    },
  });
  expect(umfrage.ok(), `Umfrage: ${umfrage.status()}`).toBeTruthy();
  await anna.page.goto(`${s.wurzel}/chats/${s.gruppe.id}`);
  await anna.page.getByRole('button', { name: 'Termin erstellen' }).click();
  const umfrageFeld = anna.page.locator('#poll-event-location');
  await expect(umfrageFeld).toHaveAttribute('aria-describedby', 'poll-event-location-hint');
  await umfrageFeld.fill('Hauptstr. 5, 12345 Berlin');
  await expect(anna.page.locator('#poll-event-location-hint')).toContainText('Adresse erkannt');
  await umfrageFeld.fill('Stadtpark');
  await expect(anna.page.locator('#poll-event-location-hint')).toContainText(
    'Keine Adresse erkannt',
  );

  await s.http.dispose();
  await anna.page.context().close();
});

test('Tastatur und Fokus: Enter öffnet, Esc schliesst, der Fokus kehrt zurück', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  const adresse = bodo.page.getByRole('button', { name: KERN, exact: true });
  await expect(adresse).toBeVisible({ timeout: 15_000 });
  await expect(adresse).toHaveAttribute('aria-haspopup', 'dialog');

  await adresse.focus();
  await bodo.page.keyboard.press('Enter');
  const dialog = blatt(bodo.page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Der Fokus liegt auf der ersten App.
  await expect(appLink(dialog, 'Google Maps')).toBeFocused();

  // Tab führt durch das Blatt: erst die Apps, dann „Karte zeigen“ ist davor – die Reihenfolge
  // folgt dem Aufbau von oben nach unten.
  await bodo.page.keyboard.press('Tab');
  await expect(appLink(dialog, 'OpenStreetMap')).toBeFocused();

  await bodo.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(adresse).toBeFocused();

  // Mit gemerkter Wahl: Der Fokus liegt auf der gemerkten App, und „⋯“ ist erreichbar.
  await verlaufBereinigt(bodo.page);
  await bodo.page.evaluate((key) => localStorage.setItem(key, 'waze'), SPEICHER);
  await bodo.page.reload();
  const mehr = bodo.page.getByRole('button', {
    name: 'Mit anderer Karten-App oder als Route öffnen',
  });
  await expect(mehr).toBeVisible({ timeout: 15_000 });
  await mehr.focus();
  await bodo.page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(appLink(dialog, 'Waze')).toBeFocused();
  await bodo.page.keyboard.press('Escape');
  await expect(mehr).toBeFocused();

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Schmaler Bildschirm: Berührungsflächen, kein waagerechtes Scrollen', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  // Ein langes Wort ohne Leerzeichen: Es muss umbrechen, nicht die Seite verbreitern.
  const lang = `${'Vereinsheimstrasse'.repeat(4)}, Hauptstr. 5, 12345 Berlin`;
  const termin = await s.termin(lang);
  const bodo = await zugang(browser, s.bodo, s.wurzel, { viewport: { width: 375, height: 740 } });

  const ohneSeitwaerts = async (name: string) => {
    const breiten = await bodo.page.evaluate(() => ({
      seite: document.documentElement.scrollWidth - window.innerWidth,
      rumpf: document.body.scrollWidth - window.innerWidth,
    }));
    expect(breiten.seite, `${name}: Seite`).toBeLessThanOrEqual(0);
    expect(breiten.rumpf, `${name}: Rumpf`).toBeLessThanOrEqual(0);
  };

  // ---- Chatkarte ----
  await bodo.page.goto(`${s.wurzel}/chats/${s.gruppe.id}`);
  const karte = bodo.page.locator('.cal-bubble').filter({ hasText: termin.title });
  await expect(karte).toBeVisible({ timeout: 15_000 });
  await ohneSeitwaerts('Chatkarte');
  const kartenBreite = await karte.evaluate((el) => ({
    innen: el.scrollWidth,
    aussen: el.clientWidth,
  }));
  expect(kartenBreite.innen).toBeLessThanOrEqual(kartenBreite.aussen);
  await bild(bodo.page, 'chatkarte-375');

  // ---- Detail ----
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  const adresse = bodo.page.locator('.cal-detail-facts .ort-link');
  await expect(adresse).toBeVisible({ timeout: 15_000 });
  await ohneSeitwaerts('Detail');
  const hoehe = (await adresse.boundingBox())?.height ?? 0;
  expect(hoehe).toBeGreaterThanOrEqual(44);
  await bild(bodo.page, 'detail-375');

  // ---- Blatt ----
  await adresse.click();
  const dialog = blatt(bodo.page);
  await expect(dialog).toBeVisible();
  await ohneSeitwaerts('Blatt');
  const blattBreite = await dialog.evaluate((el) => ({
    innen: el.scrollWidth,
    aussen: el.clientWidth,
  }));
  expect(blattBreite.innen).toBeLessThanOrEqual(blattBreite.aussen);
  await bild(bodo.page, 'blatt-375');

  const mindestens44 = async (locator: Locator, name: string) => {
    const anzahl = await locator.count();
    expect(anzahl, `${name}: gefunden`).toBeGreaterThan(0);
    for (let i = 0; i < anzahl; i += 1) {
      const kasten = await locator.nth(i).boundingBox();
      expect(kasten?.height ?? 0, `${name} ${i}`).toBeGreaterThanOrEqual(44);
    }
  };
  await mindestens44(dialog.locator('.karten-app'), 'App-Zeile');
  await mindestens44(dialog.locator('.prf-segment-btn'), 'Umschalter');
  await mindestens44(dialog.getByRole('button', { name: 'Adresse kopieren' }), 'Adresse kopieren');
  await mindestens44(dialog.locator('.karten-merken'), 'Wahl merken');
  await mindestens44(dialog.locator('.karten-aendern'), 'Karten-App ändern');

  // ---- Einstellung ----
  await bodo.page.keyboard.press('Escape');
  await verlaufBereinigt(bodo.page);
  await bodo.page.goto(`${s.wurzel}/profil/einstellungen#karten-app`);
  await expect(bodo.page.locator('#karten-app')).toBeVisible({ timeout: 15_000 });
  await ohneSeitwaerts('Einstellung');
  await mindestens44(bodo.page.locator('#karten-app [role="radio"]'), 'Radio');

  await s.http.dispose();
  await bodo.page.context().close();
});

test('„Adresse kopieren“ legt den Adresskern in die Zwischenablage', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel, {
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await bodo.page.getByRole('button', { name: KERN, exact: true }).click();
  await blatt(bodo.page).getByRole('button', { name: 'Adresse kopieren' }).click();
  await expect(bodo.page.getByText('Adresse kopiert')).toBeVisible();
  expect(await bodo.page.evaluate(() => navigator.clipboard.readText())).toBe(KERN);

  // Auch eine Koordinate: kopiert wird „Breite, Länge“.
  const punkt = await s.termin('Treffpunkt 48.13743, 11.57549 am Brunnen');
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${punkt.id}`);
  await bodo.page.getByRole('button', { name: '48.13743, 11.57549', exact: true }).click();
  const dialog = blatt(bodo.page);
  await expect(dialog.locator('.karten-ziel')).toHaveText('48.13743, 11.57549');
  await expect(appLink(dialog, 'OpenStreetMap')).toHaveAttribute(
    'href',
    'https://www.openstreetmap.org/?mlat=48.13743&mlon=11.57549#map=17/48.13743/11.57549',
  );
  await dialog
    .getByRole('group', { name: 'Was soll geöffnet werden?' })
    .getByRole('button', { name: 'Route hierher' })
    .click();
  // Bei Koordinaten kann auch OpenStreetMap die Route.
  expect(await appNamen(dialog)).toEqual(['Google Maps', 'OpenStreetMap', 'Bing Karten', 'Waze']);
  await expect(appLink(dialog, 'OpenStreetMap')).toHaveAttribute(
    'href',
    'https://www.openstreetmap.org/directions?route=%3B48.13743%2C11.57549',
  );

  await s.http.dispose();
  await bodo.page.context().close();
});

test('Plattformen: Android bekommt geo:, iPhone zuerst Apple Karten', async ({
  browser,
  baseURL,
}) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const android = await zugang(browser, s.bodo, s.wurzel, {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 800 },
  });
  const iphone = await zugang(browser, s.anna, s.wurzel, {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });

  // ---- Android: Standard-Karten-App zuerst, `geo:` ohne Zielfenster ----
  await android.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await android.page.getByRole('button', { name: KERN, exact: true }).click();
  const blattAndroid = blatt(android.page);
  expect(await appNamen(blattAndroid)).toEqual([
    'Standard-Karten-App',
    'Google Maps',
    'OpenStreetMap',
    'Waze',
    'Bing Karten',
  ]);
  const geo = appLink(blattAndroid, 'Standard-Karten-App');
  await expect(geo).toHaveAttribute('href', `geo:0,0?q=${KERN_KODIERT}`);
  await expect(geo).not.toHaveAttribute('target', /.*/);
  await expect(appLink(blattAndroid, 'Apple Karten')).toHaveCount(0);
  // Route: `geo:` kennt keine.
  await blattAndroid.getByRole('button', { name: 'Route hierher' }).click();
  await expect(appLink(blattAndroid, 'Standard-Karten-App')).toHaveCount(0);

  // ---- iPhone: Apple Karten zuerst ----
  await iphone.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await iphone.page.getByRole('button', { name: KERN, exact: true }).click();
  const blattIphone = blatt(iphone.page);
  expect(await appNamen(blattIphone)).toEqual([
    'Apple Karten',
    'Google Maps',
    'Waze',
    'OpenStreetMap',
    'Bing Karten',
  ]);
  await expect(appLink(blattIphone, 'Apple Karten')).toHaveAttribute(
    'href',
    `https://maps.apple.com/?q=${KERN_KODIERT}`,
  );
  await expect(appLink(blattIphone, 'Standard-Karten-App')).toHaveCount(0);

  // Ein gemerktes „Standard-Karten-App“ aus einem anderen Gerät gilt hier nicht:
  // Auf dem iPhone öffnet sich wieder das Blatt, statt ins Leere zu führen.
  await iphone.page.keyboard.press('Escape');
  await verlaufBereinigt(iphone.page);
  await iphone.page.evaluate((key) => localStorage.setItem(key, 'system'), SPEICHER);
  await iphone.page.reload();
  await expect(iphone.page.getByRole('button', { name: KERN, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(iphone.page.locator('.cal-detail-facts a.ort-link')).toHaveCount(0);

  // ---- Einstellung zeigt dieselben Apps ----
  await android.page.goto(`${s.wurzel}/profil/einstellungen#karten-app`);
  const gruppe = android.page.getByRole('radiogroup', { name: 'Karten-App' });
  await expect(gruppe.getByRole('radio', { name: /^Standard-Karten-App/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(gruppe.getByRole('radio', { name: /^Apple Karten/ })).toHaveCount(0);

  await s.http.dispose();
  await android.page.context().close();
  await iphone.page.context().close();
});

test('Vor dem Tippen geht nichts an Karten-Anbieter', async ({ browser, baseURL }) => {
  const s = await szenario(baseURL);
  const termin = await s.termin(ORT);
  const bodo = await zugang(browser, s.bodo, s.wurzel);

  // Chat mit Karte, Agenda, Termin, Einstellung – ein Rundgang, ohne etwas zu tippen.
  await bodo.page.goto(`${s.wurzel}/chats/${s.gruppe.id}`);
  await expect(bodo.page.locator('.cal-bubble').filter({ hasText: termin.title })).toBeVisible({
    timeout: 15_000,
  });
  await bodo.page.goto(`${s.wurzel}/kalender`);
  await bodo.page.getByRole('tab', { name: 'Agenda' }).click();
  await expect(bodo.page.getByText(termin.title)).toBeVisible({ timeout: 15_000 });
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await expect(bodo.page.getByRole('button', { name: KERN, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await bodo.page.goto(`${s.wurzel}/profil/einstellungen#karten-app`);
  await expect(bodo.page.locator('#karten-app')).toBeVisible({ timeout: 15_000 });

  // Auch mit gemerkter Wahl (echte Links) wird nichts im Voraus geholt.
  await bodo.page.evaluate((key) => localStorage.setItem(key, 'google'), SPEICHER);
  await bodo.page.goto(`${s.wurzel}/kalender/termin/${termin.id}`);
  await expect(bodo.page.locator('.cal-detail-facts a.ort-link')).toBeVisible({ timeout: 15_000 });
  // Keine Vorabruf-Hinweise für die Karten-Hosts im Dokument.
  expect(
    await bodo.page.evaluate(
      () =>
        document.querySelectorAll(
          'link[rel="prefetch"], link[rel="preconnect"], link[rel="dns-prefetch"]',
        ).length,
    ),
  ).toBe(0);

  // Gar nichts nach draussen, nicht nur nichts an Karten-Anbieter.
  expect(bodo.fremd.map((anfrage) => anfrage.url)).toEqual([]);

  await s.http.dispose();
  await bodo.page.context().close();
});
