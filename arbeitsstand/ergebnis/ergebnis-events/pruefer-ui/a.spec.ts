import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, als, registrieren, seiteFuer, terminAnlegen, type Sitzung } from './lib';

test.describe.configure({ mode: 'serial' });

test.describe('Prüfer UI', () => {
  let http: APIRequestContext;
  let wurzel: string;
  let a: Sitzung, b: Sitzung, c: Sitzung, d: Sitzung, e: Sitzung;
  let gruppe: { id: string; title: string };
  let termin: { id: string; title: string };
  let seiteA: Page;

  test.beforeAll(async ({ browser, baseURL }) => {
    http = await request.newContext();
    wurzel = baseURL!;
    a = await registrieren(http, 'prua');
    b = await registrieren(http, 'prub');
    c = await registrieren(http, 'pruc');
    d = await registrieren(http, 'prud');
    e = await registrieren(http, 'prue');
    gruppe = await (
      await http.post(`${API}/conversations`, {
        headers: als(a),
        data: { type: 'group', title: `Pruefer-Skat ${Date.now()}`, memberIds: [b.user.id, c.user.id, d.user.id] },
      })
    ).json();
    termin = await terminAnlegen(http, a, `Pruefer-Grillen ${Date.now()}`, {
      attendeeIds: [b.user.id, c.user.id],
      zustellung: { senden: true, einzelchats: true, gruppenChatIds: [gruppe.id] },
    });
    // B sagt zu
    const r = await http.post(`${API}/calendar/events/${termin.id}/rsvp`, { headers: als(b), data: { status: 'yes' } });
    expect(r.ok()).toBeTruthy();
    seiteA = await seiteFuer(browser, a, wurzel);
  });

  test('P1 Detailseite: Nachträglich einladen – Vorschau', async () => {
    await seiteA.goto(`${wurzel}/kalender/termin/${termin.id}`);
    await expect(seiteA.getByText(termin.title).first()).toBeVisible({ timeout: 15_000 });
    await seiteA.getByText(/Nachträglich einladen|Jemanden einladen/).first().click();
    const vorschau = seiteA.getByRole('status', { name: 'Was mit der Einladung geschieht' });
    await expect(vorschau).toBeVisible({ timeout: 10_000 });
    await seiteA.waitForTimeout(500);
    console.log('P1 VORSCHAU (nichts gewählt):', JSON.stringify(await vorschau.innerText()));
    await seiteA.screenshot({ path: '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pruefer-ui/p1-detail.png', fullPage: true });
    // D anhaken
    const dz = seiteA.getByRole('checkbox', { name: new RegExp(d.user.displayName) });
    await dz.check();
    await seiteA.waitForTimeout(300);
    console.log('P1 VORSCHAU (D gewählt):', JSON.stringify(await vorschau.innerText()));
  });
  const blatt = (seite: Page) => seite.getByRole('dialog');

  test('P2 gruppenFehler: Laden der Gruppenkarten scheitert', async ({ browser }) => {
    const seite = await seiteFuer(browser, a, wurzel);
    await seite.goto(`${wurzel}/kalender/termin/${termin.id}`);
    await expect(seite.getByText(termin.title).first()).toBeVisible({ timeout: 15_000 });
    await seite.route(`**/api/v1/calendar/events/${termin.id}/zustellung`, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
    );
    await seite.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
    await expect(blatt(seite)).toBeVisible();
    await seite.waitForTimeout(4000);
    const t = await blatt(seite).innerText();
    console.log('P2 enthält "Gruppenkarten werden geladen":', t.includes('Gruppenkarten werden geladen'));
    console.log('P2 enthält Fehlertext:', /nicht möglich|fehlgeschlagen|konnte nicht/.test(t));
    await seite.context().close();
  });

  test('P3 gewählter Suchtreffer (kein Kontakt) behält seinen Namen', async ({ browser }) => {
    const seite = await seiteFuer(browser, a, wurzel);
    await seite.goto(`${wurzel}/kalender`);
    await seite.getByRole('button', { name: /Neuer Termin/ }).click();
    await expect(blatt(seite)).toBeVisible();
    await seite.locator('#cal-title').fill('x');
    await seite.getByRole('searchbox', { name: 'Person suchen' }).fill(e.user.username);
    const weitere = blatt(seite).getByRole('group', { name: 'Weitere Personen', exact: true });
    await expect(weitere.getByText(e.user.displayName)).toBeVisible({ timeout: 15_000 });
    console.log('P3 vor Haken:', JSON.stringify(await weitere.innerText()));
    await weitere.getByRole('checkbox').check();
    console.log('P3 sofort nach Haken:', JSON.stringify(await weitere.innerText()));
    await seite.waitForTimeout(2000);
    console.log('P3 2s nach Haken:', JSON.stringify(await weitere.innerText()));
    await seite.context().close();
  });

  test('P4 Niemand beim Bearbeiten: Rückfrage-Text', async ({ browser }) => {
    const seite = await seiteFuer(browser, a, wurzel);
    await seite.goto(`${wurzel}/kalender/termin/${termin.id}`);
    await expect(seite.getByText(termin.title).first()).toBeVisible({ timeout: 15_000 });
    await seite.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
    await expect(blatt(seite)).toBeVisible();
    const liste = blatt(seite).getByRole('group', { name: 'Personen', exact: true });
    await expect(liste.getByRole('checkbox', { checked: true })).toHaveCount(2, { timeout: 15_000 });
    await liste.getByRole('checkbox', { name: new RegExp(c.user.displayName) }).uncheck();
    await blatt(seite).getByRole('button', { name: 'Niemand einladen' }).click();
    const frage = blatt(seite).getByRole('group', { name: 'Rückfrage' });
    console.log('P4 Rückfrage:', JSON.stringify(await frage.innerText()));
    await seite.context().close();
  });

});
