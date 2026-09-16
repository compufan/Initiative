import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Löschen, teilen, Priorität – durch die echte Oberfläche.
 *
 * Die Regeln dahinter haben ihre eigenen Tests auf der Serverseite
 * (`apps/api/tests/dateiaktionen.rs`). Hier geht es um den Weg dorthin, und
 * der hat eine Stelle, die sich nur im Browser prüfen lässt: die
 * **Mehrfachauswahl nach langem Drücken**. Sie besteht aus einer Geste, einem
 * Zeitgeber und der Entscheidung, dass ein kurzer Tipp danach etwas anderes
 * tut als vorher. Keines davon fällt beim Übersetzen auf.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

/** 1×1 transparentes PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const daten = {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
  const antwort = await http.post(`${API}/auth/register`, { data: daten });
  expect(antwort.ok(), `Registrierung ${daten.username}: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(baseURL);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

/** Eine fertige Datei hochladen und ihre Kennung zurückgeben. */
async function hochladen(http: APIRequestContext, sitzung: Sitzung, name: string): Promise<string> {
  const kopf = { authorization: `Bearer ${sitzung.accessToken}` };
  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: kopf,
      data: { kind: 'image', mime: 'image/png', size: PNG.length, fileName: name },
    })
  ).json();
  const hoch = await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: kopf,
    multipart: { file: { name, mimeType: 'image/png', buffer: PNG } },
  });
  expect(hoch.ok(), `Hochladen ${name}: ${hoch.status()}`).toBeTruthy();
  await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: kopf,
    data: { width: 1, height: 1 },
  });
  return upload.attachmentId as string;
}

/**
 * Langes Drücken auf einer Kachel.
 *
 * Die Handler hängen an `.fil-tile-open`, und `useLongPress` bricht ab, sobald
 * sich der Zeiger um mehr als zwölf Punkte bewegt – deshalb wird der Zeiger
 * vor dem Drücken gesetzt und danach nicht mehr angefasst.
 */
async function langDruecken(page: Page, name: string) {
  const kachel = page.locator('.fil-tile-open').filter({ hasText: name }).first();
  await expect(kachel).toBeVisible({ timeout: 15_000 });
  const kasten = await kachel.boundingBox();
  if (!kasten) throw new Error(`Die Kachel „${name}“ hat keine Fläche`);
  await page.mouse.move(kasten.x + kasten.width / 2, kasten.y + kasten.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

test('lange drücken wählt aus, und die Auswahl bekommt eine Priorität', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'prio');
  const kopf = { authorization: `Bearer ${anna.accessToken}` };

  const sammlung = await (
    await http.post(`${API}/collections`, {
      headers: kopf,
      data: { name: `Urlaub ${Date.now()}` },
    })
  ).json();
  const erste = await hochladen(http, anna, 'strand.png');
  const zweite = await hochladen(http, anna, 'berge.png');
  for (const anhang of [erste, zweite]) {
    const angelegt = await http.post(`${API}/collections/${sammlung.id}/items`, {
      headers: kopf,
      data: { attachmentId: anhang },
    });
    expect(angelegt.ok(), `Eintrag: ${angelegt.status()}`).toBeTruthy();
  }

  const wurzel = baseURL ?? 'http://localhost:5173';
  const seite = await seiteFuer(browser, anna, wurzel);
  await seite.goto(`${wurzel}/dateien/${sammlung.id}`);
  await expect(seite.getByText('strand.png').first()).toBeVisible({ timeout: 15_000 });

  // Vor dem langen Drücken gibt es keine Auswahlleiste.
  await expect(seite.getByText(/ausgewählt/)).toHaveCount(0);

  await langDruecken(seite, 'strand.png');
  await expect(seite.getByText('1 ausgewählt')).toBeVisible({ timeout: 10_000 });

  /*
   * Und jetzt wählt ein KURZER Tipp weiter aus, statt die Datei zu öffnen.
   *
   * Das ist die eigentliche Behauptung dieses Tests. Ginge stattdessen der
   * Betrachter auf, müsste man zwischen zwei Dateien jedes Mal ein Vollbild
   * wegklicken – und es fiele niemandem auf, der die Geste nicht selbst
   * ausprobiert.
   */
  await seite.locator('.fil-tile-open').filter({ hasText: 'berge.png' }).first().click();
  await expect(seite.getByText('2 ausgewählt')).toBeVisible();
  await expect(seite.locator('.fv-backdrop')).toHaveCount(0);

  await seite.getByRole('button', { name: '⋯ Aktionen' }).click();
  await seite.getByRole('button', { name: /Priorität ändern/ }).click();
  await seite.getByRole('button', { name: /^Niedrig/ }).click();
  await expect(seite.getByText(/Priorität: Niedrig/)).toBeVisible({ timeout: 10_000 });

  // Und der Server weiss es auch – für BEIDE.
  const eintraege = await (
    await http.get(`${API}/collections/${sammlung.id}/items`, { headers: kopf })
  ).json();
  const prioritaeten = eintraege.items.map(
    (eintrag: { attachment: { prioritaet: string } }) => eintrag.attachment.prioritaet,
  );
  expect(prioritaeten.sort()).toEqual(['niedrig', 'niedrig']);

  await http.dispose();
});

test('eine ausgewählte Datei lässt sich in einen Chat weitergeben', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'teil');
  const ben = await registrieren(http, 'teilben');
  const kopf = { authorization: `Bearer ${anna.accessToken}` };

  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: kopf,
      data: { type: 'direct', memberIds: [ben.user.id] },
    })
  ).json();
  const sammlung = await (
    await http.post(`${API}/collections`, {
      headers: kopf,
      data: { name: `Weitergeben ${Date.now()}` },
    })
  ).json();
  const anhang = await hochladen(http, anna, 'strand.png');
  await http.post(`${API}/collections/${sammlung.id}/items`, {
    headers: kopf,
    data: { attachmentId: anhang },
  });

  const wurzel = baseURL ?? 'http://localhost:5173';
  const seite = await seiteFuer(browser, anna, wurzel);
  await seite.goto(`${wurzel}/dateien/${sammlung.id}`);
  await langDruecken(seite, 'strand.png');
  await expect(seite.getByText('1 ausgewählt')).toBeVisible({ timeout: 10_000 });

  await seite.getByRole('button', { name: '⋯ Aktionen' }).click();
  await seite.getByRole('button', { name: /In einem Chat teilen/ }).click();
  await seite.getByRole('button', { name: new RegExp(ben.user.displayName) }).click();
  await expect(seite.getByText(/geschickt/)).toBeVisible({ timeout: 10_000 });

  /*
   * Im Chat liegt jetzt eine Nachricht mit derselben Datei – und zwar mit
   * einer ZWEITEN Zeile darauf, nicht mit der ersten. Das Original bleibt in
   * der Sammlung, wo es war.
   */
  const nachrichten = await (
    await http.get(`${API}/conversations/${chat.id}/messages`, { headers: kopf })
  ).json();
  const mitAnhang = nachrichten.items.filter(
    (nachricht: { attachments: unknown[] }) => nachricht.attachments.length > 0,
  );
  expect(mitAnhang).toHaveLength(1);
  expect(mitAnhang[0].attachments[0].id).not.toBe(anhang);
  // Und zwar als BILD, nicht als Textnachricht mit etwas daneben: Die
  // Oberfläche wählt die Blase nach dem Typ aus.
  expect(mitAnhang[0].type).toBe('image');

  const eintraege = await (
    await http.get(`${API}/collections/${sammlung.id}/items`, { headers: kopf })
  ).json();
  expect(eintraege.items).toHaveLength(1);
  expect(eintraege.items[0].attachment.id).toBe(anhang);

  await http.dispose();
});
