import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Termine einladen – mit mehreren Nutzern, wie es im Alltag läuft.
 *
 * Fünf Konten: **A** legt Termine an, **B**, **C** und **D** sitzen mit A in
 * einem Gruppenchat G, **E** kennt niemand. Jedes Konto hat seinen eigenen
 * Browser, damit das Echtzeit-Verhalten – eine Zusage, die in allen Karten
 * ankommt, ein Ausgeladener, dessen Karte sich ändert – wirklich über den
 * Server läuft und nicht über einen gemeinsamen Speicher.
 *
 * Die Tests bauen aufeinander auf (Termin 1 und 2 leben durch die Datei) und
 * laufen darum der Reihe nach.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; username: string };
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

interface Nachricht {
  id: string;
  type: string;
  metadata: { eventId?: string };
  event?: { title: string };
  deletedAt: string | null;
}

test.describe.configure({ mode: 'serial' });

test.describe('Termine einladen', () => {
  let http: APIRequestContext;
  let wurzel: string;
  let a: Sitzung;
  let b: Sitzung;
  let c: Sitzung;
  let d: Sitzung;
  let e: Sitzung;
  let seiteA: Page;
  let seiteB: Page;
  let seiteC: Page;
  let seiteD: Page;
  let gruppe: { id: string; title: string };
  const t1 = { titel: '', id: '' };
  const t2 = { titel: '', id: '' };

  test.beforeAll(async ({ browser, baseURL }) => {
    http = await request.newContext();
    wurzel = baseURL ?? 'http://localhost:5173';
    a = await registrieren(http, 'einla');
    b = await registrieren(http, 'einlb');
    c = await registrieren(http, 'einlc');
    d = await registrieren(http, 'einld');
    e = await registrieren(http, 'einle');
    gruppe = await (
      await http.post(`${API}/conversations`, {
        headers: als(a),
        data: {
          type: 'group',
          title: `Skat ${Date.now()}`,
          memberIds: [b.user.id, c.user.id, d.user.id],
        },
      })
    ).json();
    t1.titel = `Grillen ${Date.now()}`;
    t2.titel = `Wandern ${Date.now()}`;
    seiteA = await seiteFuer(browser, a, wurzel);
    seiteB = await seiteFuer(browser, b, wurzel);
    seiteC = await seiteFuer(browser, c, wurzel);
    seiteD = await seiteFuer(browser, d, wurzel);
  });

  test.afterAll(async () => {
    await http?.dispose();
    for (const seite of [seiteA, seiteB, seiteC, seiteD]) await seite?.context().close();
  });

  /* ---------- Hilfen ---------- */

  async function chatsVon(sitzung: Sitzung) {
    const antwort = await http.get(`${API}/conversations`, { headers: als(sitzung) });
    return (await antwort.json()).items as {
      id: string;
      type: string;
      members: { userId: string }[];
    }[];
  }

  /** Der Einzelchat von `sitzung` mit `andere` – oder `undefined`. */
  async function einzelchat(sitzung: Sitzung, andere: Sitzung) {
    return (await chatsVon(sitzung)).find(
      (chat) =>
        chat.type === 'direct' &&
        chat.members.some((mitglied) => mitglied.userId === andere.user.id),
    );
  }

  async function nachrichten(sitzung: Sitzung, chatId: string): Promise<Nachricht[]> {
    const antwort = await http.get(`${API}/conversations/${chatId}/messages`, {
      headers: als(sitzung),
    });
    return (await antwort.json()).items;
  }

  /** Die Karten eines Termins in einem Chat, so wie `sitzung` sie sieht. */
  async function karten(sitzung: Sitzung, chatId: string, terminId: string) {
    return (await nachrichten(sitzung, chatId)).filter(
      (nachricht) =>
        nachricht.type === 'event' &&
        !nachricht.deletedAt &&
        nachricht.metadata.eventId === terminId,
    );
  }

  async function terminId(sitzung: Sitzung, titel: string): Promise<string> {
    const antwort = await http.get(`${API}/calendar/events`, { headers: als(sitzung) });
    const termin = ((await antwort.json()).items as { id: string; title: string }[]).find(
      (eintrag) => eintrag.title === titel,
    );
    expect(termin, `Termin „${titel}“ in der Liste`).toBeTruthy();
    return termin!.id;
  }

  const blatt = (seite: Page) => seite.getByRole('dialog');
  const liste = (seite: Page) => blatt(seite).getByRole('group', { name: 'Personen', exact: true });
  // Der Zähler ist die eine Live-Region, deren Text genau „n von m Personen“ ist.
  const zaehler = (seite: Page) =>
    blatt(seite)
      .getByRole('status')
      .filter({ hasText: /^\d+ von \d+ Personen?$/ });
  // Die Schalter sind unsichtbar (die Spur ist das Bild): Man tippt die Zeile an.
  const postenSchalter = (seite: Page) =>
    blatt(seite).getByRole('switch', { name: /^Dort posten:/ });
  const postenZeile = (seite: Page) => blatt(seite).locator('li.cal-einl-chip label.cal-switch');
  const vorschau = (seite: Page) =>
    blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' });

  async function editorOeffnen(seite: Page, titel: string) {
    await seite.goto(`${wurzel}/kalender`);
    await seite.getByRole('button', { name: /Neuer Termin/ }).click();
    await expect(blatt(seite)).toBeVisible();
    await seite.locator('#cal-title').fill(titel);
  }

  const person = (seite: Page, sitzung: Sitzung) =>
    liste(seite).getByRole('checkbox', { name: new RegExp(sitzung.user.displayName) });

  /* ---------- B1 ---------- */

  test('die Personenliste steht ohne Suche da', async () => {
    await editorOeffnen(seiteA, 'Probe');

    // Ohne eine Taste zu drücken: alle Kontakte aus dem gemeinsamen Gruppenchat.
    for (const sitzung of [b, c, d]) {
      await expect(person(seiteA, sitzung)).toBeVisible({ timeout: 15_000 });
      await expect(person(seiteA, sitzung)).not.toBeChecked();
    }
    await expect(zaehler(seiteA)).toHaveText('0 von 3 Personen');
    await expect(seiteA.getByRole('searchbox', { name: 'Person suchen' })).toHaveValue('');

    // Wer keinen gemeinsamen Chat hat, steht nicht in der Liste.
    await expect(liste(seiteA).getByText(e.user.displayName)).toHaveCount(0);
  });

  /* ---------- B2 ---------- */

  test('Suche filtert, Alle und Niemand wirken, das Verzeichnis ergänzt', async () => {
    const suche = seiteA.getByRole('searchbox', { name: 'Person suchen' });

    // Filtert sofort: nur B bleibt.
    await suche.fill(b.user.username);
    await expect(liste(seiteA).getByRole('checkbox')).toHaveCount(1);
    await expect(person(seiteA, b)).toBeVisible();
    await suche.fill('');
    await expect(liste(seiteA).getByRole('checkbox')).toHaveCount(3);

    // Alle wählt Personen – und keinen Gruppenchat.
    await seiteA.getByRole('button', { name: 'Alle Kontakte einladen' }).click();
    await expect(liste(seiteA).getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(zaehler(seiteA)).toHaveText('3 von 3 Personen');
    await expect(blatt(seiteA).getByRole('list', { name: 'Ausgewählte Gruppenchats' })).toHaveCount(
      0,
    );
    // … und bietet die Gruppe stattdessen als Vorschlag an.
    await expect(blatt(seiteA).getByRole('button', { name: /Auch in „Skat/ })).toBeVisible();

    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
    await expect(zaehler(seiteA)).toHaveText('0 von 3 Personen');

    // E kennt A nicht: erst die Suche (ab zwei Zeichen) findet sie.
    await suche.fill(e.user.username);
    await expect(
      blatt(seiteA).getByRole('heading', { name: 'Weitere Personen auf diesem Server' }),
    ).toBeVisible({
      timeout: 15_000,
    });
    const weitere = blatt(seiteA).getByRole('group', { name: 'Weitere Personen', exact: true });
    await expect(weitere.getByText(e.user.displayName)).toBeVisible({ timeout: 15_000 });
    await expect(weitere.getByText('nicht in deinen Chats')).toBeVisible();
    await weitere.getByRole('checkbox').check();
    await expect(zaehler(seiteA)).toHaveText('1 von 4 Personen');
    await weitere.getByRole('checkbox').uncheck();
    await suche.fill('');
    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
  });

  /* ---------- B3 ---------- */

  test('Gruppenchat wählt Mitglieder, einzelne sind abwählbar, die Vorschau sagt es', async () => {
    await seiteA.getByRole('button', { name: /Gruppenchat …/ }).click();
    await blatt(seiteA)
      .getByRole('button', { name: new RegExp(gruppe.title) })
      .click();

    // Die Mitglieder sind gewählt, der Chip zählt A als Ersteller mit.
    await expect(liste(seiteA).getByRole('checkbox', { checked: true })).toHaveCount(3);
    const chip = blatt(seiteA).getByRole('list', { name: 'Ausgewählte Gruppenchats' });
    await expect(chip).toContainText('4 von 4 eingeladen');
    await expect(vorschau(seiteA)).toContainText(`Gruppenchat „${gruppe.title}“: Karte.`);
    await expect(vorschau(seiteA)).toContainText('3 Einzelchats');

    // D abwählen: der Chip wird unvollständig, die Gruppe bekommt keine Karte.
    await person(seiteA, d).uncheck();
    await expect(chip).toContainText('3 von 4 eingeladen');
    await expect(chip).toContainText('hier wird nicht gepostet');
    await expect(vorschau(seiteA)).toContainText(
      `Gruppenchat „${gruppe.title}“: keine Karte – ${d.user.displayName} fehlt.`,
    );
    await expect(vorschau(seiteA)).toContainText('2 Einzelchats');
    await expect(postenSchalter(seiteA)).toBeDisabled();

    // D wieder wählen: alles wie vorher.
    await person(seiteA, d).check();
    await expect(vorschau(seiteA)).toContainText(`Gruppenchat „${gruppe.title}“: Karte.`);

    // Der Schalter „Dort posten“ lässt die Gruppe aus.
    await postenZeile(seiteA).click();
    await expect(postenSchalter(seiteA)).not.toBeChecked();
    await expect(vorschau(seiteA)).toContainText(
      `Gruppenchat „${gruppe.title}“: keine Karte (abgewählt).`,
    );
    await postenZeile(seiteA).click();
    await expect(postenSchalter(seiteA)).toBeChecked();
    await expect(vorschau(seiteA)).toContainText(`Gruppenchat „${gruppe.title}“: Karte.`);
  });

  /* ---------- B4 ---------- */

  test('die Zustellung stimmt mit der Vorschau überein', async () => {
    // (a) Termin 1: Gruppe vollständig, „dort posten“ an – Karte in G und in jedem Einzelchat.
    await seiteA.locator('#cal-title').fill(t1.titel);
    await seiteA.getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(
      seiteA.getByText(/Termin erstellt – Karte im Gruppenchat, 3 Einzelchats/),
    ).toBeVisible({ timeout: 15_000 });

    t1.id = await terminId(a, t1.titel);
    expect(await karten(a, gruppe.id, t1.id)).toHaveLength(1);
    for (const andere of [b, c, d]) {
      const chat = await einzelchat(a, andere);
      expect(chat, 'Einzelchat mit dem Eingeladenen').toBeTruthy();
      expect(await karten(a, chat!.id, t1.id), 'genau eine Karte im Einzelchat').toHaveLength(1);
    }

    // B sieht sie in seinem Browser: im Einzelchat mit A.
    const abB = await einzelchat(b, a);
    await seiteB.goto(`${wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });

    // (b) Termin 2: nur B und C, die Gruppe nicht gewählt – keine Karte in G, keine in AD.
    await editorOeffnen(seiteA, t2.titel);
    await person(seiteA, b).check();
    await person(seiteA, c).check();
    await expect(zaehler(seiteA)).toHaveText('2 von 3 Personen');
    await expect(vorschau(seiteA)).toContainText('2 Einzelchats');
    await expect(vorschau(seiteA)).not.toContainText('Gruppenchat „');
    await seiteA.getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(seiteA.getByText(/Termin erstellt – 2 Einzelchats\./)).toBeVisible({
      timeout: 15_000,
    });

    t2.id = await terminId(a, t2.titel);
    expect(await karten(a, gruppe.id, t2.id)).toHaveLength(0);
    expect(await karten(a, (await einzelchat(a, b))!.id, t2.id)).toHaveLength(1);
    expect(await karten(a, (await einzelchat(a, c))!.id, t2.id)).toHaveLength(1);
    expect(await karten(a, (await einzelchat(a, d))!.id, t2.id)).toHaveLength(0);
  });

  /* ---------- B5 ---------- */

  test('wer im Gruppenchat, aber nicht eingeladen ist, sieht den Termin nicht', async () => {
    // D ist in G, aber zu Termin 2 nicht eingeladen: kein Zugang, kein Eintrag, keine Karte.
    await seiteD.goto(`${wurzel}/kalender/termin/${t2.id}`);
    await expect(seiteD.getByText('Termin nicht gefunden')).toBeVisible({ timeout: 15_000 });

    const liste_ = await http.get(`${API}/calendar/events`, { headers: als(d) });
    const titel = ((await liste_.json()).items as { title: string }[]).map((x) => x.title);
    expect(titel).not.toContain(t2.titel);
    expect(titel).toContain(t1.titel);

    const detail = await http.get(`${API}/calendar/events/${t2.id}`, { headers: als(d) });
    expect(detail.status()).toBe(404);
  });

  /* ---------- B6 ---------- */

  test('die Zusage gilt in allen Karten, live und ohne Neuladen', async () => {
    // A schaut sich zuerst jede Karte an – Gruppenchat und die drei Einzelchats – und
    // geht zurück zur Chatliste. Danach sind alle vier Chats geladen, und beim nächsten
    // Öffnen holt die App nur noch Neueres: Eine Karte, die sich in der Zwischenzeit
    // geändert hat, stimmt nur, wenn der Speicher sie nachgeführt hat.
    const ziele: [string, string][] = [
      ['Gruppe', gruppe.id],
      ['B', (await einzelchat(a, b))!.id],
      ['C', (await einzelchat(a, c))!.id],
      ['D', (await einzelchat(a, d))!.id],
    ];
    await seiteA.goto(`${wurzel}/chats`);
    for (const [name, chat] of ziele) {
      await seiteA.locator(`a.chat-row[href="/chats/${chat}"]`).click();
      await expect(
        seiteA.locator('.cal-bubble').filter({ hasText: t1.titel }),
        `Karte im Chat ${name}, vorher`,
      ).toContainText('1 zugesagt', { timeout: 15_000 });
      await seiteA.goBack();
    }

    // C sitzt im Gruppenchat.
    await seiteC.goto(`${wurzel}/chats/${gruppe.id}`);
    const kartenC = seiteC.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(kartenC).toBeVisible({ timeout: 15_000 });
    // Der Ersteller hat von Anfang an zugesagt.
    await expect(kartenC).toContainText('1 zugesagt');

    // B sagt in seinem Einzelchat zu.
    const abB = await einzelchat(b, a);
    await seiteB.goto(`${wurzel}/chats/${abB!.id}`);
    const kartenB = seiteB.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(kartenB).toBeVisible({ timeout: 15_000 });
    await kartenB.getByRole('button', { name: 'Zusagen' }).click();
    await expect(kartenB).toContainText('2 zugesagt', { timeout: 15_000 });

    // C sieht es in der Gruppenkarte, ohne Neuladen.
    await expect(kartenC).toContainText('2 zugesagt', { timeout: 15_000 });

    // A geht zurück in die vier Chats, ohne Neuladen der Seite: Jede Karte zeigt den
    // neuen Stand – auch die in Chats, die A in der Zwischenzeit nicht offen hatte.
    for (const [name, chat] of ziele) {
      await seiteA.locator(`a.chat-row[href="/chats/${chat}"]`).click();
      await expect(
        seiteA.locator('.cal-bubble').filter({ hasText: t1.titel }),
        `Karte im Chat ${name}, nachher`,
      ).toContainText('2 zugesagt', { timeout: 15_000 });
      await seiteA.goBack();
    }

    // Nach dem Neuladen von A: unverändert.
    await seiteA.reload();
    await seiteA.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
    await expect(seiteA.locator('.cal-bubble').filter({ hasText: t1.titel })).toContainText(
      '2 zugesagt',
      { timeout: 15_000 },
    );
  });

  /* ---------- B7 ---------- */

  test('Bearbeiten: einladen und ausladen, live in den Chats der Betroffenen', async () => {
    // D schaut im Einzelchat mit A auf Termin 1 – dort kommt gleich Termin 2 dazu.
    const adD = await einzelchat(d, a);
    await seiteD.goto(`${wurzel}/chats/${adD!.id}`);
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0);
    // C schaut im Einzelchat mit A auf Termin 2 – der gleich verschwindet.
    const acC = await einzelchat(c, a);
    await seiteC.goto(`${wurzel}/chats/${acC!.id}`);
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });

    await seiteA.goto(`${wurzel}/kalender/termin/${t2.id}`);
    await seiteA.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
    await expect(blatt(seiteA)).toBeVisible();

    // Beim Bearbeiten stehen die heutigen Eingeladenen angehakt, mit ihrer Antwort.
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });
    await expect(person(seiteA, c)).toBeChecked();
    await expect(person(seiteA, d)).not.toBeChecked();
    await expect(liste(seiteA).getByText('Offen')).toHaveCount(2);

    await person(seiteA, d).check();
    await person(seiteA, c).uncheck();
    await expect(vorschau(seiteA)).toContainText('Neu eingeladen: 1');
    await expect(vorschau(seiteA)).toContainText('Entfernt: 1');
    await blatt(seiteA).getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(seiteA.getByText(/Termin gespeichert/)).toBeVisible({ timeout: 15_000 });

    // D: Die Karte erscheint live im Einzelchat.
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });
    // C: Die Karte verschwindet live, und der Termin ist nicht mehr erreichbar.
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0, {
      timeout: 15_000,
    });
    await seiteC.goto(`${wurzel}/kalender/termin/${t2.id}`);
    await expect(seiteC.getByText('Termin nicht gefunden')).toBeVisible({ timeout: 15_000 });
  });

  test('Ausladen aus dem Gruppenchat: die Karte bleibt, zeigt dem Ausgeladenen aber nichts', async () => {
    // C schaut im Gruppenchat auf Termin 1.
    await seiteC.goto(`${wurzel}/chats/${gruppe.id}`);
    const karteC = seiteC.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(karteC).toBeVisible({ timeout: 15_000 });

    // A lädt C auf der Terminseite aus.
    await seiteA.goto(`${wurzel}/kalender/termin/${t1.id}`);
    await seiteA
      .getByRole('button', { name: new RegExp(`${c.user.displayName} ausladen`) })
      .click();

    await expect(seiteC.getByText('Du bist nicht mehr zu diesem Termin eingeladen.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(seiteC.getByText(t1.titel)).toHaveCount(0);

    // Auch nach dem Neuladen steht dort nichts, was verrät, worum es ging: weder Titel
    // noch Kennung in der Nachricht.
    const inG = (await nachrichten(c, gruppe.id)).filter((n) => n.type === 'event');
    const karte = inG.find((n) => n.deletedAt == null);
    expect(karte, 'die Gruppenkarte steht weiter da').toBeTruthy();
    expect(karte!.event).toBeUndefined();
    expect(karte!.metadata.eventId).toBeUndefined();

    // Und der Zugang ist weg.
    const detail = await http.get(`${API}/calendar/events/${t1.id}`, { headers: als(c) });
    expect(detail.status()).toBe(404);

    // Die Einzelkarte von C ist gelöscht.
    const acC = await einzelchat(c, a);
    expect(await karten(c, acC!.id, t1.id)).toHaveLength(0);
  });

  test('Rückfragen: Ausladen einer Zusage und „Niemand“ beim Bearbeiten', async () => {
    // B hat Termin 1 zugesagt (siehe oben). Wer eine Zusage ausladen will, wird
    // vorher gefragt; „Abbrechen“ lässt alles, wie es ist.
    await seiteA.goto(`${wurzel}/kalender/termin/${t1.id}`);
    await seiteA
      .getByRole('button', { name: new RegExp(`${b.user.displayName} ausladen`) })
      .click();
    await expect(blatt(seiteA).getByRole('heading', { name: 'Wirklich ausladen?' })).toBeVisible();
    await expect(blatt(seiteA)).toContainText('hatte zugesagt');
    await blatt(seiteA).getByRole('button', { name: 'Abbrechen' }).click();
    await expect(
      seiteA.getByRole('button', { name: new RegExp(`${b.user.displayName} ausladen`) }),
    ).toBeVisible();
    const detail = await http.get(`${API}/calendar/events/${t1.id}`, { headers: als(b) });
    expect(detail.status(), 'B ist weiter eingeladen').toBe(200);

    // Im Editor heisst „Niemand“ auch: die schon Eingeladenen ausladen. Das fragt nach.
    await seiteA.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });
    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
    const frage = blatt(seiteA).getByRole('group', { name: 'Rückfrage' });
    await expect(frage).toContainText('2 Personen werden ausgeladen');
    await frage.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(frage).toHaveCount(0);
    await expect(person(seiteA, b)).toBeChecked();
    await expect(person(seiteA, d)).toBeChecked();

    // Wer die Einladungen nicht anfasst, sendet nichts davon: Nur der Titel ändert sich.
    await blatt(seiteA).getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(seiteA.getByText('Termin gespeichert', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect((await http.get(`${API}/calendar/events/${t1.id}`, { headers: als(d) })).status()).toBe(
      200,
    );
  });

  test('Nachträglich einladen auf der Terminseite: Einzelkarte live, Gruppenkarte beim Öffnen', async () => {
    // C ist seit dem Ausladen weg: Im Gruppenchat steht für C eine leere Karte.
    await seiteC.goto(`${wurzel}/chats`);
    const reihe = (chat: string) => seiteC.locator(`a.chat-row[href="/chats/${chat}"]`);
    await reihe(gruppe.id).click();
    await expect(seiteC.getByText('Termin nicht verfügbar.')).toBeVisible({ timeout: 15_000 });
    await seiteC.goBack();
    // C schaut in den Einzelchat mit A.
    const acC = await einzelchat(c, a);
    await reihe(acC!.id).click();
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t1.titel })).toHaveCount(0);

    // A lädt C auf der Terminseite wieder ein. In der Liste steht nur, wer noch fehlt.
    await seiteA.goto(`${wurzel}/kalender/termin/${t1.id}`);
    await seiteA.getByText('Jemanden einladen').click();
    const feld = seiteA.locator('details.cal-invite');
    const wahl = feld.getByRole('group', { name: 'Personen', exact: true });
    await expect(wahl.getByRole('checkbox')).toHaveCount(1, { timeout: 15_000 });
    await wahl.getByRole('checkbox', { name: new RegExp(c.user.displayName) }).check();
    await expect(feld).toContainText('Neu eingeladen: 1');
    await feld.getByRole('button', { name: 'Einladen', exact: true }).click();
    await expect(seiteA.getByText('Eingeladen.', { exact: true })).toBeVisible({ timeout: 15_000 });

    // C: Die Karte im Einzelchat erscheint live.
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });
    // Und beim nächsten Öffnen des Gruppenchats zeigt die leere Karte den Termin.
    await seiteC.goBack();
    await reihe(gruppe.id).click();
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });
    expect((await http.get(`${API}/calendar/events/${t1.id}`, { headers: als(c) })).status()).toBe(
      200,
    );
  });

  /* ---------- B8 ---------- */

  test('Absagen und Löschen', async () => {
    // B schaut im Einzelchat auf Termin 1, D im Einzelchat auf Termin 1 und 2.
    const abB = await einzelchat(b, a);
    await seiteB.goto(`${wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });

    // A sagt Termin 1 ab.
    await seiteA.goto(`${wurzel}/kalender/termin/${t1.id}`);
    await seiteA.getByRole('button', { name: /Termin absagen/ }).click();
    await blatt(seiteA).getByRole('button', { name: 'Absagen', exact: true }).click();
    await expect(seiteA.getByText('Dieser Termin ist abgesagt.')).toBeVisible({ timeout: 15_000 });

    // B: Die Karte zeigt „Abgesagt“, ohne Zu- und Absageknöpfe.
    const karteB = seiteB.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(karteB).toContainText('Abgesagt', { timeout: 15_000 });
    await expect(karteB.getByRole('button', { name: 'Zusagen' })).toHaveCount(0);

    // Die Zusage per API wird abgelehnt.
    const antwort = await http.post(`${API}/calendar/events/${t1.id}/rsvp`, {
      headers: als(b),
      data: { status: 'no' },
    });
    expect(antwort.status()).toBe(409);

    // Termin 2 (jetzt B und D) wird gelöscht – die Karten verschwinden bei beiden.
    const adD = await einzelchat(d, a);
    await seiteD.goto(`${wurzel}/chats/${adD!.id}`);
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });
    await seiteB.goto(`${wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });

    await seiteA.goto(`${wurzel}/kalender/termin/${t2.id}`);
    await seiteA.getByRole('button', { name: /Termin löschen/ }).click();
    await blatt(seiteA).getByRole('button', { name: 'Löschen', exact: true }).click();

    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(await karten(a, (await einzelchat(a, b))!.id, t2.id)).toHaveLength(0);
  });

  /* ---------- B9 ---------- */

  test('375 Pixel: kein seitliches Scrollen, große Tippflächen, Tastatur und Namen', async () => {
    await seiteA.setViewportSize({ width: 375, height: 812 });
    await editorOeffnen(seiteA, 'Schmal');
    await expect(person(seiteA, b)).toBeVisible({ timeout: 15_000 });

    const breite = await seiteA.evaluate(() => document.documentElement.scrollWidth);
    expect(breite, 'kein horizontaler Seitenlauf').toBeLessThanOrEqual(375);

    // Jeder Knopf und jede Zeile im Feld ist mindestens 44 Pixel hoch.
    await seiteA.getByRole('button', { name: /Gruppenchat …/ }).click();
    await blatt(seiteA)
      .getByRole('button', { name: new RegExp(gruppe.title) })
      .click();
    const zu_klein = await blatt(seiteA).evaluate((wurzel_) => {
      const feld = wurzel_.querySelector('.cal-einl');
      const ziele = [
        ...(feld?.querySelectorAll('button, label.cal-einl-zeile, label.cal-switch') ?? []),
      ];
      return ziele
        .map((ziel) => ({
          text: (ziel.textContent ?? '').trim().slice(0, 30),
          hoehe: ziel.getBoundingClientRect().height,
        }))
        .filter((ziel) => ziel.hoehe > 0 && ziel.hoehe < 43.5);
    });
    expect(zu_klein, 'Tippflächen unter 44 px').toEqual([]);

    // Namen für Vorlesehilfen.
    await expect(liste(seiteA)).toBeVisible();
    await expect(
      blatt(seiteA).getByRole('switch', { name: 'Einladung im Chat senden' }),
    ).toBeVisible();
    await expect(zaehler(seiteA)).toHaveText(/\d+ von \d+ Personen/);

    // Nur mit der Tastatur: Leertaste in einer Zeile wählt, Enter im Gruppenfeld öffnet.
    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
    await expect(zaehler(seiteA)).toHaveText('0 von 3 Personen');
    await person(seiteA, b).focus();
    await seiteA.keyboard.press('Space');
    await expect(person(seiteA, b)).toBeChecked();
    await expect(zaehler(seiteA)).toHaveText('1 von 3 Personen');

    const gruppenKnopf = blatt(seiteA).getByRole('button', { name: /Gruppenchat …/ });
    await gruppenKnopf.focus();
    await seiteA.keyboard.press('Enter');
    await expect(gruppenKnopf).toHaveAttribute('aria-expanded', 'true');
    // Der Fokus wandert auf die erste Zeile; Enter wählt die Gruppe.
    await seiteA.keyboard.press('Enter');
    await expect(zaehler(seiteA)).toHaveText('3 von 3 Personen');
    // Beim Schließen zurück zum Knopf.
    await expect(gruppenKnopf).toBeFocused();

    // Tab-Reihenfolge: Schnellwahl, dann das Suchfeld.
    await blatt(seiteA).getByRole('button', { name: 'Alle Kontakte einladen' }).focus();
    await seiteA.keyboard.press('Tab');
    await expect(blatt(seiteA).getByRole('button', { name: 'Niemand einladen' })).toBeFocused();
    await seiteA.keyboard.press('Tab');
    await expect(gruppenKnopf).toBeFocused();
    await seiteA.keyboard.press('Tab');
    await expect(blatt(seiteA).getByRole('searchbox', { name: 'Person suchen' })).toBeFocused();

    await seiteA.setViewportSize({ width: 1280, height: 720 });
  });

  /* ---------- Nachliefern ---------- */

  test('nicht zugestellte Einladungen werden gemeldet und lassen sich erneut zustellen', async () => {
    // Den Teilausfall gibt es im Betrieb nur, wenn der Server mitten im Senden
    // abbricht. Hier steht der Server-Zustand „zwei Karten fehlen“ im Netz nach –
    // geprüft wird, dass der Hinweis dauerhaft auf der Terminseite steht und das
    // Zustellen die richtige Route ruft.
    let nachgeliefert = 0;
    await seiteA.route(`**/api/v1/calendar/events/${t1.id}/zustellung`, async (route) => {
      await route.fulfill({
        json: { gruppen: [], einzelNutzerIds: [], ausstehend: nachgeliefert === 0 ? 2 : 0 },
      });
    });
    await seiteA.route(
      `**/api/v1/calendar/events/${t1.id}/zustellung/nachliefern`,
      async (route) => {
        nachgeliefert += 1;
        const termin = await (
          await http.get(`${API}/calendar/events/${t1.id}`, { headers: als(a) })
        ).json();
        await route.fulfill({
          json: {
            ...termin,
            zustellung: {
              gruppen: [],
              einzelchats: 2,
              neueEinzelchats: 0,
              ausgelassen: [],
              ausstehend: 0,
              benachrichtigt: 2,
            },
          },
        });
      },
    );

    await seiteA.goto(`${wurzel}/kalender/termin/${t1.id}`);
    const hinweis = seiteA.getByRole('alert').filter({ hasText: 'Einladungen nicht zugestellt' });
    await expect(hinweis).toContainText('2 Einladungen sind noch nicht im Chat angekommen', {
      timeout: 15_000,
    });
    await hinweis.getByRole('button', { name: 'Erneut zustellen' }).click();
    await expect(seiteA.getByText('Alle Einladungen sind zugestellt.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(hinweis).toHaveCount(0);
    expect(nachgeliefert).toBe(1);
  });

  /* ---------- aus dem Chat heraus ---------- */

  test('aus dem Chat heraus: die Vorbelegung ist sichtbar und abwählbar', async () => {
    const termin = async (chat: string) => {
      await seiteA.goto(`${wurzel}/chats/${chat}`);
      await seiteA.getByRole('button', { name: 'Mehr hinzufügen' }).click();
      await seiteA.getByRole('button', { name: 'Termin', exact: true }).click();
      await expect(blatt(seiteA)).toBeVisible();
      await expect(liste(seiteA)).toBeVisible({ timeout: 15_000 });
    };

    // Im Gruppenchat: alle Mitglieder gewählt, der Chat als Ziel, „dort posten“ an.
    await termin(gruppe.id);
    await expect(liste(seiteA).getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(zaehler(seiteA)).toHaveText('3 von 3 Personen');
    await expect(
      blatt(seiteA).getByRole('list', { name: 'Ausgewählte Gruppenchats' }),
    ).toContainText('4 von 4 eingeladen');
    await expect(vorschau(seiteA)).toContainText(`Gruppenchat „${gruppe.title}“: Karte.`);
    // Alles lässt sich abwählen.
    await blatt(seiteA)
      .getByRole('button', { name: `Gruppenchat ${gruppe.title} entfernen` })
      .click();
    await expect(vorschau(seiteA)).not.toContainText('Gruppenchat „');
    await expect(zaehler(seiteA)).toHaveText('3 von 3 Personen');
    await seiteA.keyboard.press('Escape');
    await expect(blatt(seiteA)).toHaveCount(0);
    // Das Blatt legt einen Verlaufseintrag an und nimmt ihn beim Schliessen mit einem
    // „Zurück“ wieder weg. Erst wenn das durch ist, darf die nächste Seite geladen werden –
    // sonst holt das späte „Zurück“ den Gruppenchat zurück.
    await seiteA.waitForFunction(
      () => !(history.state as { initiativeDialog?: boolean } | null)?.initiativeDialog,
    );

    // Im Einzelchat: das Gegenüber, kein Gruppenchat.
    await termin((await einzelchat(a, b))!.id);
    await expect(liste(seiteA).getByRole('checkbox', { checked: true })).toHaveCount(1);
    await expect(person(seiteA, b)).toBeChecked();
    await expect(blatt(seiteA).getByRole('list', { name: 'Ausgewählte Gruppenchats' })).toHaveCount(
      0,
    );
  });
});
