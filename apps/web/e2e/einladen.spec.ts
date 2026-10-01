import { type Page } from '@playwright/test';
import { API, als, expect, registrieren, test, type Sitzung, type Welt } from './einladenWelt.js';

/**
 * Termine einladen – mit mehreren Nutzern, wie es im Alltag läuft.
 *
 * Jeder Test hat seine eigene Welt (`einladenWelt.ts`): frische Konten, einen
 * Gruppenchat, eigene Browser. Was ein Test an Terminen braucht, legt er selbst
 * an – meist über die API, damit der Browser nur prüft, was der Test prüfen
 * will. So läuft jeder Test auch allein (`-g "Absagen"`), und ein Fehler verdeckt
 * keinen anderen.
 */

const blatt = (seite: Page) => seite.getByRole('dialog');
const liste = (seite: Page) => blatt(seite).getByRole('group', { name: 'Personen', exact: true });
// Der Zähler ist die eine Live-Region, deren Text genau „n von m Personen“ ist.
const zaehler = (seite: Page) =>
  blatt(seite)
    .getByRole('status')
    .filter({ hasText: /^\d+ von \d+ Personen?$/ });
// Die Schalter sind unsichtbar (die Spur ist das Bild): Man tippt die Zeile an.
const postenSchalter = (seite: Page) => blatt(seite).getByRole('switch', { name: /^Dort posten:/ });
const postenZeile = (seite: Page) => blatt(seite).locator('li.cal-einl-chip label.cal-switch');
const vorschau = (seite: Page) =>
  blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' });
const person = (seite: Page, sitzung: Sitzung) =>
  liste(seite).getByRole('checkbox', { name: new RegExp(sitzung.user.displayName) });

async function editorOeffnen(welt: Welt, seite: Page, titel: string) {
  await seite.goto(`${welt.wurzel}/kalender`);
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.locator('#cal-title').fill(titel);
}

/** Der Termin im Editor: Terminseite öffnen, „Bearbeiten“ tippen, warten, bis die Wahl steht. */
async function terminBearbeiten(welt: Welt, seite: Page, terminId: string) {
  await seite.goto(`${welt.wurzel}/kalender/termin/${terminId}`);
  await seite.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
  await expect(blatt(seite)).toBeVisible();
}

test.describe('Termine einladen', () => {
  /* ---------- B1 ---------- */

  test('die Personenliste steht ohne Suche da', async ({ welt }) => {
    const e = await welt.fremder();
    const seiteA = await welt.seite(welt.a);
    await editorOeffnen(welt, seiteA, 'Probe');

    // Ohne eine Taste zu drücken: alle Kontakte aus dem gemeinsamen Gruppenchat.
    for (const sitzung of [welt.b, welt.c, welt.d]) {
      await expect(person(seiteA, sitzung)).toBeVisible({ timeout: 15_000 });
      await expect(person(seiteA, sitzung)).not.toBeChecked();
    }
    await expect(zaehler(seiteA)).toHaveText('0 von 3 Personen');
    await expect(seiteA.getByRole('searchbox', { name: 'Person suchen' })).toHaveValue('');

    // Wer keinen gemeinsamen Chat hat, steht nicht in der Liste.
    await expect(liste(seiteA).getByText(e.user.displayName)).toHaveCount(0);
  });

  /* ---------- B2 ---------- */

  test('Suche filtert, Alle und Niemand wirken, das Verzeichnis ergänzt', async ({ welt }) => {
    const { b } = welt;
    const e = await welt.fremder();
    const seiteA = await welt.seite(welt.a);
    await editorOeffnen(welt, seiteA, 'Probe');
    await expect(person(seiteA, b)).toBeVisible({ timeout: 15_000 });
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

    // Abgewählt bleibt die Person in der Liste: Wer nur über die Suche erreichbar
    // ist, ließe sich sonst nach einem Versehen nicht mehr zurückwählen. Auch ohne
    // den Suchtext, der sie gefunden hat.
    await suche.fill('');
    await expect(weitere.getByRole('checkbox')).toHaveCount(1);
    await weitere.getByRole('checkbox').uncheck();
    await expect(weitere.getByRole('checkbox')).toHaveCount(1);
    await expect(zaehler(seiteA)).toHaveText('0 von 3 Personen');
    await weitere.getByRole('checkbox').check();
    await expect(zaehler(seiteA)).toHaveText('1 von 4 Personen');
  });

  /* ---------- B3 ---------- */

  test('Gruppenchat wählt Mitglieder, einzelne sind abwählbar, die Vorschau sagt es', async ({
    welt,
  }) => {
    const { gruppe, d } = welt;
    const seiteA = await welt.seite(welt.a);
    await editorOeffnen(welt, seiteA, 'Probe');
    await expect(person(seiteA, welt.b)).toBeVisible({ timeout: 15_000 });

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

  test('die Zustellung stimmt mit der Vorschau überein', async ({ welt }) => {
    const { a, b, c, d, gruppe } = welt;
    const seiteA = await welt.seite(a);
    const t1 = `Grillen ${Date.now()}`;
    const t2 = `Wandern ${Date.now()}`;

    // (a) Termin 1: Gruppe vollständig, „dort posten“ an – Karte in G und in jedem Einzelchat.
    await editorOeffnen(welt, seiteA, t1);
    await expect(person(seiteA, b)).toBeVisible({ timeout: 15_000 });
    await seiteA.getByRole('button', { name: /Gruppenchat …/ }).click();
    await blatt(seiteA)
      .getByRole('button', { name: new RegExp(gruppe.title) })
      .click();
    await seiteA.getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(
      seiteA.getByText(/Termin erstellt – Karte im Gruppenchat, 3 Einzelchats/),
    ).toBeVisible({ timeout: 15_000 });

    const id1 = await welt.terminId(a, t1);
    expect(await welt.karten(a, gruppe.id, id1)).toHaveLength(1);
    for (const andere of [b, c, d]) {
      const chat = await welt.einzelchat(a, andere);
      expect(chat, 'Einzelchat mit dem Eingeladenen').toBeTruthy();
      expect(await welt.karten(a, chat!.id, id1), 'genau eine Karte im Einzelchat').toHaveLength(1);
    }

    // B sieht sie in seinem Browser: im Einzelchat mit A.
    const seiteB = await welt.seite(b);
    const abB = await welt.einzelchat(b, a);
    await seiteB.goto(`${welt.wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t1 })).toBeVisible({
      timeout: 15_000,
    });

    // (b) Termin 2: nur B und C, die Gruppe nicht gewählt – keine Karte in G, keine in AD.
    await editorOeffnen(welt, seiteA, t2);
    await person(seiteA, b).check();
    await person(seiteA, c).check();
    await expect(zaehler(seiteA)).toHaveText('2 von 3 Personen');
    await expect(vorschau(seiteA)).toContainText('2 Einzelchats');
    await expect(vorschau(seiteA)).not.toContainText('Gruppenchat „');
    await seiteA.getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(seiteA.getByText(/Termin erstellt – 2 Einzelchats\./)).toBeVisible({
      timeout: 15_000,
    });

    const id2 = await welt.terminId(a, t2);
    expect(await welt.karten(a, gruppe.id, id2)).toHaveLength(0);
    expect(await welt.karten(a, (await welt.einzelchat(a, b))!.id, id2)).toHaveLength(1);
    expect(await welt.karten(a, (await welt.einzelchat(a, c))!.id, id2)).toHaveLength(1);
    expect(await welt.karten(a, (await welt.einzelchat(a, d))!.id, id2)).toHaveLength(0);
  });

  /* ---------- B5 ---------- */

  test('wer im Gruppenchat, aber nicht eingeladen ist, sieht den Termin nicht', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const t2 = await welt.terminAnlegen(a, { personen: [b, c] });
    const seiteD = await welt.seite(d);

    // D ist in G, aber zu Termin 2 nicht eingeladen: kein Zugang, kein Eintrag, keine Karte.
    await seiteD.goto(`${welt.wurzel}/kalender/termin/${t2.id}`);
    await expect(seiteD.getByText('Termin nicht gefunden')).toBeVisible({ timeout: 15_000 });

    const liste_ = await welt.http.get(`${API}/calendar/events`, { headers: als(d) });
    const titel = ((await liste_.json()).items as { title: string }[]).map((x) => x.title);
    expect(titel).not.toContain(t2.titel);
    expect(titel).toContain(t1.titel);

    const detail = await welt.http.get(`${API}/calendar/events/${t2.id}`, { headers: als(d) });
    expect(detail.status()).toBe(404);
  });

  /* ---------- B6 ---------- */

  test('die Zusage gilt in allen Karten, live und ohne Neuladen', async ({ welt }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const [seiteA, seiteB, seiteC] = [
      await welt.seite(a),
      await welt.seite(b),
      await welt.seite(c),
    ];

    // A schaut sich zuerst jede Karte an – Gruppenchat und die drei Einzelchats – und
    // geht zurück zur Chatliste. Danach sind alle vier Chats geladen, und beim nächsten
    // Öffnen holt die App nur noch Neueres: Eine Karte, die sich in der Zwischenzeit
    // geändert hat, stimmt nur, wenn der Speicher sie nachgeführt hat.
    const ziele: [string, string][] = [
      ['Gruppe', gruppe.id],
      ['B', (await welt.einzelchat(a, b))!.id],
      ['C', (await welt.einzelchat(a, c))!.id],
      ['D', (await welt.einzelchat(a, d))!.id],
    ];
    await seiteA.goto(`${welt.wurzel}/chats`);
    for (const [name, chat] of ziele) {
      await seiteA.locator(`a.chat-row[href="/chats/${chat}"]`).click();
      await expect(
        seiteA.locator('.cal-bubble').filter({ hasText: t1.titel }),
        `Karte im Chat ${name}, vorher`,
      ).toContainText('1 zugesagt', { timeout: 15_000 });
      await seiteA.goBack();
    }

    // C sitzt im Gruppenchat.
    await seiteC.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    const kartenC = seiteC.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(kartenC).toBeVisible({ timeout: 15_000 });
    // Der Ersteller hat von Anfang an zugesagt.
    await expect(kartenC).toContainText('1 zugesagt');

    // B sagt in seinem Einzelchat zu.
    const abB = await welt.einzelchat(b, a);
    await seiteB.goto(`${welt.wurzel}/chats/${abB!.id}`);
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

  test('Bearbeiten: einladen und ausladen, live in den Chats der Betroffenen', async ({ welt }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const t2 = await welt.terminAnlegen(a, { personen: [b, c] });
    const [seiteA, seiteC, seiteD] = [
      await welt.seite(a),
      await welt.seite(c),
      await welt.seite(d),
    ];

    // D schaut im Einzelchat mit A auf Termin 1 – dort kommt gleich Termin 2 dazu.
    const adD = await welt.einzelchat(d, a);
    await seiteD.goto(`${welt.wurzel}/chats/${adD!.id}`);
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0);
    // C schaut im Einzelchat mit A auf Termin 2 – der gleich verschwindet.
    const acC = await welt.einzelchat(c, a);
    await seiteC.goto(`${welt.wurzel}/chats/${acC!.id}`);
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });

    await terminBearbeiten(welt, seiteA, t2.id);

    // Beim Bearbeiten stehen die heutigen Eingeladenen angehakt, mit ihrer Antwort.
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });
    await expect(person(seiteA, c)).toBeChecked();
    await expect(person(seiteA, d)).not.toBeChecked();
    await expect(liste(seiteA).getByText('Offen')).toHaveCount(2);

    await person(seiteA, d).check();
    await person(seiteA, c).uncheck();
    await expect(vorschau(seiteA)).toContainText('Neu eingeladen: 1');
    // Mit Namen: Wer versehentlich abwählt, sieht, wen es trifft.
    await expect(vorschau(seiteA)).toContainText(`Entfernt: 1 (${c.user.displayName})`);
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
    await seiteC.goto(`${welt.wurzel}/kalender/termin/${t2.id}`);
    await expect(seiteC.getByText('Termin nicht gefunden')).toBeVisible({ timeout: 15_000 });
  });

  test('Ausladen aus dem Gruppenchat: die Karte bleibt, zeigt dem Ausgeladenen aber nichts', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const [seiteA, seiteC] = [await welt.seite(a), await welt.seite(c)];

    // C schaut im Gruppenchat auf Termin 1.
    await seiteC.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    const karteC = seiteC.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(karteC).toBeVisible({ timeout: 15_000 });

    // A lädt C auf der Terminseite aus.
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await seiteA
      .getByRole('button', { name: new RegExp(`${c.user.displayName} ausladen`) })
      .click();

    await expect(seiteC.getByText('Du bist nicht mehr zu diesem Termin eingeladen.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(seiteC.getByText(t1.titel)).toHaveCount(0);

    // Auch nach dem Neuladen steht dort nichts, was verrät, worum es ging: weder Titel
    // noch Kennung in der Nachricht.
    const inG = (await welt.nachrichten(c, gruppe.id)).filter((n) => n.type === 'event');
    const karte = inG.find((n) => n.deletedAt == null);
    expect(karte, 'die Gruppenkarte steht weiter da').toBeTruthy();
    expect(karte!.event).toBeUndefined();
    expect(karte!.metadata.eventId).toBeUndefined();

    // Und der Zugang ist weg.
    const detail = await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(c) });
    expect(detail.status()).toBe(404);

    // Die Einzelkarte von C ist gelöscht.
    const acC = await welt.einzelchat(c, a);
    expect(await welt.karten(c, acC!.id, t1.id)).toHaveLength(0);
  });

  test('Rückfragen: Ausladen einer Zusage und „Niemand“ beim Bearbeiten', async ({ welt }) => {
    const { a, b, d } = welt;
    // B und D sind eingeladen, B hat zugesagt.
    const t1 = await welt.terminAnlegen(a, { personen: [b, d] });
    await welt.zusagen(b, t1, 'yes');
    const seiteA = await welt.seite(a);

    // Wer eine Zusage ausladen will, wird vorher gefragt; „Abbrechen“ lässt alles, wie es ist.
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await seiteA
      .getByRole('button', { name: new RegExp(`${b.user.displayName} ausladen`) })
      .click();
    await expect(blatt(seiteA).getByRole('heading', { name: 'Wirklich ausladen?' })).toBeVisible();
    await expect(blatt(seiteA)).toContainText('hatte zugesagt');
    await blatt(seiteA).getByRole('button', { name: 'Abbrechen' }).click();
    await expect(
      seiteA.getByRole('button', { name: new RegExp(`${b.user.displayName} ausladen`) }),
    ).toBeVisible();
    const detail = await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(b) });
    expect(detail.status(), 'B ist weiter eingeladen').toBe(200);

    // Im Editor heisst „Niemand“ auch: die schon Eingeladenen ausladen. Das fragt nach –
    // als Hinweis, der den Fokus mitnimmt, damit auch Tastatur und Vorlesehilfe es merken.
    await seiteA.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });
    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
    const frage = blatt(seiteA).getByRole('alert', { name: 'Rückfrage' });
    await expect(frage).toContainText('2 Personen werden ausgeladen');
    await expect(frage).toBeFocused();
    await frage.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(frage).toHaveCount(0);
    await expect(person(seiteA, b)).toBeChecked();
    await expect(person(seiteA, d)).toBeChecked();

    // Wer die Einladungen nicht anfasst, sendet nichts davon: Nur der Titel ändert sich.
    await blatt(seiteA).getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(seiteA.getByText('Termin gespeichert', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(
      (await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(d) })).status(),
    ).toBe(200);
  });

  test('Rückfrage bei „Niemand“: Einzahl, und Esc schließt im Gruppenfeld nur das Feld', async ({
    welt,
  }) => {
    const { a, b } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b] });
    const seiteA = await welt.seite(a);
    await terminBearbeiten(welt, seiteA, t1.id);
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });

    await seiteA.getByRole('button', { name: 'Niemand einladen' }).click();
    const frage = blatt(seiteA).getByRole('alert', { name: 'Rückfrage' });
    await expect(frage).toContainText('1 Person wird ausgeladen');
    await expect(frage).toContainText('Ihre Karte im Einzelchat wird gelöscht');
    await frage.getByRole('button', { name: 'Abbrechen' }).click();

    // Die Vorschau ist eine Liste in einer Live-Region, nicht eine Liste, die selbst
    // zur Live-Region erklärt wurde.
    const region = vorschau(seiteA);
    await person(seiteA, b).uncheck();
    await expect(region.getByRole('listitem').first()).toContainText('Entfernt: 1');
    await expect(region.locator('ul')).not.toHaveAttribute('role', 'status');
    await person(seiteA, b).check();

    // Esc im geöffneten Gruppenfeld schließt nur das Feld, nicht das Blatt mit allen Eingaben.
    const gruppenKnopf = blatt(seiteA).getByRole('button', { name: /Gruppenchat …/ });
    await gruppenKnopf.click();
    await expect(gruppenKnopf).toHaveAttribute('aria-expanded', 'true');
    await seiteA.keyboard.press('Escape');
    await expect(gruppenKnopf).toHaveAttribute('aria-expanded', 'false');
    await expect(blatt(seiteA)).toBeVisible();
    await expect(gruppenKnopf).toBeFocused();
    // Das zweite Esc schließt dann das Blatt.
    await seiteA.keyboard.press('Escape');
    await expect(blatt(seiteA)).toHaveCount(0);
  });

  test('Nachträglich einladen auf der Terminseite: Einzelkarte live, Gruppenkarte beim Öffnen', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    // C ist weg: Im Gruppenchat steht für C eine leere Karte.
    await welt.ausladen(a, t1, c);
    const [seiteA, seiteC] = [await welt.seite(a), await welt.seite(c)];

    await seiteC.goto(`${welt.wurzel}/chats`);
    const reihe = (chat: string) => seiteC.locator(`a.chat-row[href="/chats/${chat}"]`);
    await reihe(gruppe.id).click();
    await expect(seiteC.getByText('Termin nicht verfügbar.')).toBeVisible({ timeout: 15_000 });
    await seiteC.goBack();
    // C schaut in den Einzelchat mit A.
    const acC = await welt.einzelchat(c, a);
    await reihe(acC!.id).click();
    await expect(seiteC.locator('.cal-bubble').filter({ hasText: t1.titel })).toHaveCount(0);

    // A lädt C auf der Terminseite wieder ein. In der Liste steht nur, wer noch fehlt.
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
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
    expect(
      (await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(c) })).status(),
    ).toBe(200);
  });

  test('Nachträglich einladen: die Vorschau sagt nichts von Ausladen, und es gibt Auskunft, wenn alle eingeladen sind', async ({
    welt,
  }) => {
    const { a, b, c, d } = welt;
    // Nur B ist eingeladen; C und D fehlen.
    const t1 = await welt.terminAnlegen(a, { personen: [b] });
    await welt.zusagen(b, t1, 'yes');
    const seiteA = await welt.seite(a);
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await seiteA.getByText('Jemanden einladen').click();
    const feld = seiteA.locator('details.cal-invite');
    const wahl = feld.getByRole('group', { name: 'Personen', exact: true });
    const hinweis = feld.getByRole('status', { name: 'Was mit der Einladung geschieht' });
    await expect(wahl.getByRole('checkbox')).toHaveCount(2, { timeout: 15_000 });

    // Ohne Auswahl steht dort nichts – schon gar nicht, dass B ausgeladen würde.
    await expect(hinweis).toBeEmpty();
    await expect(feld).not.toContainText('Entfernt');
    await wahl.getByRole('checkbox', { name: new RegExp(c.user.displayName) }).check();
    await expect(hinweis).toContainText('Neu eingeladen: 1');
    await expect(feld).not.toContainText('Entfernt');
    await expect(feld).not.toContainText('hatte zugesagt');

    // Auch nach dem Einladen der Übrigen: Der Satz „keine Kontakte“ wäre falsch.
    await wahl.getByRole('checkbox', { name: new RegExp(d.user.displayName) }).check();
    await feld.getByRole('button', { name: '2 Personen einladen' }).click();
    await expect(seiteA.getByText('2 eingeladen.', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(feld).toContainText('Alle deine Kontakte sind schon eingeladen');
    await expect(feld).not.toContainText('Du hast noch keine Kontakte');
    await expect(feld).not.toContainText('0 von 0');
  });

  /* ---------- B8 ---------- */

  test('Absagen und Löschen', async ({ welt }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const t2 = await welt.terminAnlegen(a, { personen: [b, d] });
    const [seiteA, seiteB, seiteD] = [
      await welt.seite(a),
      await welt.seite(b),
      await welt.seite(d),
    ];

    // B schaut im Einzelchat auf Termin 1.
    const abB = await welt.einzelchat(b, a);
    await seiteB.goto(`${welt.wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t1.titel })).toBeVisible({
      timeout: 15_000,
    });

    // A sagt Termin 1 ab.
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await seiteA.getByRole('button', { name: /Termin absagen/ }).click();
    await blatt(seiteA).getByRole('button', { name: 'Absagen', exact: true }).click();
    await expect(seiteA.getByText('Dieser Termin ist abgesagt.')).toBeVisible({ timeout: 15_000 });

    // B: Die Karte zeigt „Abgesagt“, ohne Zu- und Absageknöpfe.
    const karteB = seiteB.locator('.cal-bubble').filter({ hasText: t1.titel });
    await expect(karteB).toContainText('Abgesagt', { timeout: 15_000 });
    await expect(karteB.getByRole('button', { name: 'Zusagen' })).toHaveCount(0);

    // Die Zusage per API wird abgelehnt.
    const antwort = await welt.http.post(`${API}/calendar/events/${t1.id}/rsvp`, {
      headers: als(b),
      data: { status: 'no' },
    });
    expect(antwort.status()).toBe(409);

    // Termin 2 (B und D) wird gelöscht – die Karten verschwinden bei beiden.
    const adD = await welt.einzelchat(d, a);
    await seiteD.goto(`${welt.wurzel}/chats/${adD!.id}`);
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });
    await seiteB.goto(`${welt.wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t2.titel })).toBeVisible({
      timeout: 15_000,
    });

    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t2.id}`);
    await seiteA.getByRole('button', { name: /Termin löschen/ }).click();
    await blatt(seiteA).getByRole('button', { name: 'Löschen', exact: true }).click();

    await expect(seiteB.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(seiteD.locator('.cal-bubble').filter({ hasText: t2.titel })).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(await welt.karten(a, (await welt.einzelchat(a, b))!.id, t2.id)).toHaveLength(0);
  });

  test('Sich selbst austragen: der Termin verschwindet für die Person, der Ersteller sieht es', async ({
    welt,
  }) => {
    const { a, b, c } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c] });
    const [seiteA, seiteB] = [await welt.seite(a), await welt.seite(b)];
    const abB = await welt.einzelchat(b, a);
    expect(await welt.karten(a, abB!.id, t1.id)).toHaveLength(1);

    // B schaut auf die Terminseite: Er ist nur eingeladen und trägt sich aus.
    await seiteB.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await expect(seiteB.getByRole('heading', { name: 'Bist du dabei?' })).toBeVisible({
      timeout: 15_000,
    });
    await seiteB.getByRole('button', { name: 'Aus dem Termin austragen' }).click();
    await expect(blatt(seiteB)).toContainText('verschwindet aus deinem Kalender');
    await blatt(seiteB).getByRole('button', { name: 'Austragen', exact: true }).click();
    await expect(
      seiteB.getByText('Du bist nicht mehr zu diesem Termin eingeladen.').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Der Zugang ist weg, die Einzelkarte auch; der Ersteller und C sehen den Termin weiter.
    expect(
      (await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(b) })).status(),
    ).toBe(404);
    expect(await welt.karten(a, abB!.id, t1.id)).toHaveLength(0);
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await expect(seiteA.getByText(c.user.displayName).first()).toBeVisible({ timeout: 15_000 });
    await expect(seiteA.locator('ul.cal-attendees').getByText(b.user.displayName)).toHaveCount(0);
    // Der Ersteller hat keinen „Austragen“-Knopf – er kann den Termin löschen.
    await expect(seiteA.getByRole('button', { name: 'Aus dem Termin austragen' })).toHaveCount(0);
  });

  test('eine Terminfindung bietet kein nachträgliches Einladen an', async ({ welt }) => {
    const { a, b } = welt;
    const seiteA = await welt.seite(a);
    const beginn = Date.now() + 5 * 86_400_000;
    const antwort = await welt.http.post(`${API}/calendar/planning`, {
      headers: als(a),
      data: {
        conversationId: welt.gruppe.id,
        title: `Wann? ${Date.now()}`,
        slots: [
          { startsAt: new Date(beginn).toISOString() },
          { startsAt: new Date(beginn + 86_400_000).toISOString() },
        ],
      },
    });
    expect(antwort.ok()).toBeTruthy();
    const planung = await antwort.json();

    await seiteA.goto(`${welt.wurzel}/kalender/termin/${planung.id}`);
    await expect(seiteA.getByRole('heading', { name: 'Teilnehmende' })).toBeVisible({
      timeout: 15_000,
    });
    // Wer später dazukäme, bekäme eine Karte, könnte aber nicht abstimmen.
    await expect(seiteA.getByText('Jemanden einladen')).toHaveCount(0);

    // Auch der Server lehnt es ab.
    const nachtrag = await welt.http.patch(`${API}/calendar/events/${planung.id}`, {
      headers: als(a),
      data: {
        attendeeIds: [b.user.id, welt.c.user.id, welt.d.user.id, (await welt.fremder()).user.id],
      },
    });
    expect(nachtrag.status()).toBe(400);
  });

  /* ---------- B9 ---------- */

  test('375 Pixel: kein seitliches Scrollen, große Tippflächen, Tastatur und Namen', async ({
    welt,
  }) => {
    const { gruppe, b } = welt;
    const seiteA = await welt.seite(welt.a);
    await seiteA.setViewportSize({ width: 375, height: 812 });
    await editorOeffnen(welt, seiteA, 'Schmal');
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
  });

  /* ---------- Nachliefern ---------- */

  test('nicht zugestellte Einladungen werden gemeldet und lassen sich erneut zustellen', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    const seiteA = await welt.seite(a);

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
          await welt.http.get(`${API}/calendar/events/${t1.id}`, { headers: als(a) })
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

    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
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

  test('Nachträglich einladen: fehlt eine Karte, meldet es die Antwort und der Hinweis erscheint sofort', async ({
    welt,
  }) => {
    const { a, b, c } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b] });
    const seiteA = await welt.seite(a);

    // Der Server meldet auf das Einladen „eine Karte fehlt“ – und weiter, dass sie
    // fehlt, wenn die Seite nachfragt.
    await seiteA.route(`**/api/v1/calendar/events/${t1.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const antwort = await route.fetch();
      const json = await antwort.json();
      json.zustellung = { ...json.zustellung, ausstehend: 1 };
      return route.fulfill({ response: antwort, json });
    });
    await seiteA.route(`**/api/v1/calendar/events/${t1.id}/zustellung`, async (route) => {
      await route.fulfill({ json: { gruppen: [], einzelNutzerIds: [], ausstehend: 1 } });
    });

    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    const hinweis = seiteA.getByRole('alert').filter({ hasText: 'Einladungen nicht zugestellt' });
    await expect(hinweis).toHaveCount(1, { timeout: 15_000 });
    await seiteA.getByText('Jemanden einladen').click();
    const feld = seiteA.locator('details.cal-invite');
    await feld
      .getByRole('group', { name: 'Personen', exact: true })
      .getByRole('checkbox', { name: new RegExp(c.user.displayName) })
      .check();
    await feld.getByRole('button', { name: 'Einladen', exact: true }).click();

    // Kein grünes „Eingeladen.“ allein: Die Meldung nennt, was nicht ankam.
    await expect(seiteA.getByText(/nicht zugestellt werden/)).toBeVisible({ timeout: 15_000 });
    await expect(hinweis).toContainText('Eine Einladung ist noch nicht im Chat angekommen');
  });

  /* ---------- Bearbeiten: Gruppenkarten, Archiv, Kaltstart ---------- */

  test('Bearbeiten: lässt sich nicht laden, wo der Termin steht, wird es gesagt und gesperrt', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const t1 = await welt.terminAnlegen(a, { personen: [b, c, d] });
    const seiteA = await welt.seite(a);

    let ausfall = true;
    await seiteA.route(`**/api/v1/calendar/events/${t1.id}/zustellung`, async (route) => {
      if (ausfall) return route.fulfill({ status: 500, json: { error: { message: 'kaputt' } } });
      return route.fallback();
    });
    await terminBearbeiten(welt, seiteA, t1.id);
    await expect(person(seiteA, b)).toBeChecked({ timeout: 15_000 });

    // Statt für immer „wird geladen“: der Fehler, ein Knopf – und die Gruppenwahl ist gesperrt.
    const meldung = blatt(seiteA).getByRole('alert').filter({ hasText: 'ließ sich nicht laden' });
    await expect(meldung).toBeVisible({ timeout: 15_000 });
    const gruppenKnopf = blatt(seiteA).getByRole('button', { name: /Gruppenchat …/ });
    await expect(gruppenKnopf).toBeDisabled();

    // Erneut versuchen: Es lädt, die Wahl ist frei, und die Gruppenkarte lässt sich setzen.
    ausfall = false;
    await meldung.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(meldung).toHaveCount(0, { timeout: 15_000 });
    await expect(gruppenKnopf).toBeEnabled();
    await gruppenKnopf.click();
    // Mit „^“: Alle drei sind eingeladen, also steht die Gruppe auch als Vorschlag da.
    await blatt(seiteA)
      .getByRole('button', { name: new RegExp(`^${gruppe.title}`) })
      .click();
    await expect(vorschau(seiteA)).toContainText(
      `Gruppenchat „${gruppe.title}“: Karte wird gepostet.`,
    );
    await blatt(seiteA).getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(seiteA.getByText(/Termin gespeichert/)).toBeVisible({ timeout: 15_000 });
    expect(await welt.karten(a, gruppe.id, t1.id)).toHaveLength(1);
  });

  test('ein archivierter Einzelchat zählt nicht als neu angelegt', async ({ welt }) => {
    const { a, b } = welt;
    const chat = await welt.einzelchatSichern(a, b);
    const archiviert = await welt.http.patch(`${API}/conversations/${chat.id}`, {
      headers: als(a),
      data: { archived: true },
    });
    expect(archiviert.ok(), `Archivieren: ${archiviert.status()}`).toBeTruthy();
    const seiteA = await welt.seite(a);

    await editorOeffnen(welt, seiteA, 'Archiv');
    await expect(person(seiteA, b)).toBeVisible({ timeout: 15_000 });
    await person(seiteA, b).check();
    // Der Server nimmt den vorhandenen, archivierten Chat: Es entsteht keiner. Die
    // Vorschau kennt ihn (vom Server geholt) und sagt es auch so.
    await expect(vorschau(seiteA)).toContainText('1 Einzelchat.', { timeout: 15_000 });
    await expect(vorschau(seiteA)).not.toContainText('neu angelegt');

    // Gegenprobe: ohne Chat mit C entsteht einer.
    await person(seiteA, welt.c).check();
    await expect(vorschau(seiteA)).toContainText('2 Einzelchats, davon einer neu angelegt.');
    await blatt(seiteA).getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(
      seiteA.getByText(/Termin erstellt – 2 Einzelchats, davon 1 neu angelegt\./),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('beim kalten Start zeigt die Wahl „Kontakte werden geladen“, nicht „keine Kontakte“', async ({
    welt,
    browser,
  }) => {
    const { a } = welt;
    // Ein frisches Gerät: kein Zwischenspeicher, die Chatliste braucht vier Sekunden.
    const kontext = await browser.newContext();
    const seite = await kontext.newPage();
    try {
      await seite.goto(welt.wurzel);
      await seite.evaluate(
        (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
        {
          accessToken: a.accessToken,
          refreshToken: a.refreshToken,
          expiresAt: Date.now() + 3_600_000,
        },
      );
      await seite.route(/\/api\/v1\/conversations(\?|$)/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await new Promise((fertig) => setTimeout(fertig, 4000));
        return route.fallback();
      });
      await seite.goto(`${welt.wurzel}/kalender`);
      await seite.getByRole('button', { name: /Neuer Termin/ }).click();
      await expect(blatt(seite)).toBeVisible();

      // Solange die Liste fehlt: ein Ladezustand, kein „du hast keine Kontakte“.
      await expect(blatt(seite).getByText('Kontakte werden geladen')).toBeVisible();
      await expect(blatt(seite).getByText('Du hast noch keine Kontakte')).toHaveCount(0);
      await expect(blatt(seite).getByText('Niemand ist eingeladen')).toHaveCount(0);

      // Dann steht die Liste da.
      await expect(person(seite, welt.b)).toBeVisible({ timeout: 15_000 });
      await expect(blatt(seite).getByText('Du hast noch keine Kontakte')).toHaveCount(0);
    } finally {
      await kontext.close();
    }
  });

  test('Ansicht „Gewählt“: leere Fläche, hängende Ansicht und verlorener Fokus', async ({
    welt,
  }) => {
    test.setTimeout(120_000);
    const { a, b, c, d } = welt;
    // Zwölf Kontakte: B, C, D und neun weitere in einer zweiten Gruppe.
    const weitere: Sitzung[] = await Promise.all(
      Array.from({ length: 9 }, (_, nummer) => registrieren(welt.http, `einlx${nummer}`)),
    );
    await welt.http.post(`${API}/conversations`, {
      headers: als(a),
      data: {
        type: 'group',
        title: `Viele ${Date.now()}`,
        memberIds: weitere.map((person_) => person_.user.id),
      },
    });
    // B ist schon eingeladen; zur Wahl stehen auf der Terminseite 11 Personen.
    const t1 = await welt.terminAnlegen(a, { personen: [b] });
    const seiteA = await welt.seite(a);
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${t1.id}`);
    await seiteA.getByText('Jemanden einladen').click();
    const feld = seiteA.locator('details.cal-invite');
    const wahl = feld.getByRole('group', { name: 'Personen', exact: true });
    await expect(wahl.getByRole('checkbox')).toHaveCount(11, { timeout: 15_000 });

    // „Gewählt“ ohne Auswahl: kein leeres Feld, sondern ein Satz.
    const anzeigeGewaehlt = feld.getByRole('button', { name: /^Gewählt 0/ });
    await anzeigeGewaehlt.click();
    await expect(feld).toContainText('Niemand gewählt.');
    await feld.getByRole('button', { name: /^Alle 11 Personen anzeigen/ }).click();

    // Vier Personen wählen, auf „Gewählt“ stellen, eine dort abwählen: Die Zeile bleibt
    // (abgehakt) stehen, und der Fokus bleibt auf ihr.
    for (const wen of [c, d, weitere[0]!, weitere[1]!]) {
      await wahl.getByRole('checkbox', { name: new RegExp(wen.user.displayName) }).check();
    }
    await feld.getByRole('button', { name: /^Gewählt 4/ }).click();
    await expect(wahl.getByRole('checkbox')).toHaveCount(4);
    const zeile = wahl.getByRole('checkbox', { name: new RegExp(c.user.displayName) });
    await zeile.focus();
    await seiteA.keyboard.press('Space');
    await expect(zeile).not.toBeChecked();
    await expect(zeile).toBeFocused();
    await seiteA.keyboard.press('Space');
    await expect(zeile).toBeChecked();

    // Alle vier einladen: Es bleiben sieben, der Umschalter verschwindet – und mit ihm
    // die Ansicht „Gewählt“. Die Liste zeigt wieder alle sieben.
    await feld.getByRole('button', { name: '4 Personen einladen' }).click();
    await expect(seiteA.getByText('4 eingeladen.', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(wahl.getByRole('checkbox')).toHaveCount(7);
    await expect(feld.getByRole('group', { name: 'Anzeige' })).toHaveCount(0);
  });
});
