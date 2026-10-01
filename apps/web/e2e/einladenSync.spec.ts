import { API, als, expect, neueLeitung, test } from './einladenWelt.js';

/**
 * Termin-Karten bleiben richtig, wenn die Verbindung nicht mitspielt.
 *
 * Jede Karte, die Terminseite und der Kalender zeigen denselben Stand – auch
 * dann, wenn ein Rundruf verloren geht (Verbindung weg, App im Hintergrund), eine
 * Antwort zu spät kommt oder eine Karte aus dem Zwischenspeicher stammt. Jeder Test
 * hat seine eigene Welt (`einladenWelt.ts`) und läuft allein.
 */

test.describe('Termin-Karten und die Verbindung', () => {
  test('eine Zusage in einer Lücke der Verbindung erreicht die Karte beim Wiederverbinden', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const termin = await welt.terminAnlegen(a, {
      personen: [b, c, d],
      gruppen: [gruppe.id],
      einzelchats: false,
    });
    const leitung = neueLeitung();
    const seiteB = await welt.seite(b, leitung);
    await seiteB.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    const karte = seiteB.locator('.cal-bubble').filter({ hasText: termin.titel });
    await expect(karte).toContainText('1 zugesagt', { timeout: 15_000 });
    await expect.poll(() => leitung.verbunden).toBeGreaterThan(0);

    // Die Leitung reisst ab (Tunnel, Bildschirm aus), und solange sie weg ist, sagt C zu.
    leitung.luecke = true;
    leitung.trennen();
    await seiteB.waitForTimeout(1500);
    await welt.zusagen(c, termin, 'yes');
    await expect(karte).toContainText('1 zugesagt');

    // Die Leitung steht wieder: Der Client holt nach, was er verpasst hat – ohne
    // dass man die Seite neu laden oder den Chat verlassen muss.
    const verbundenVorher = leitung.verbunden;
    leitung.luecke = false;
    await expect
      .poll(() => leitung.verbunden, { timeout: 30_000 })
      .toBeGreaterThan(verbundenVorher);
    await expect(karte).toContainText('2 zugesagt', { timeout: 15_000 });
  });

  test('wieder eingeladen, Gruppenchat offen: die leere Karte füllt sich, nichts erscheint doppelt', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const termin = await welt.terminAnlegen(a, { personen: [b, c, d], gruppen: [gruppe.id] });
    // C wird ausgeladen, bevor C die App öffnet: Die Gruppenkarte kommt ohne Termin.
    await welt.ausladen(a, termin, c);
    const gesendet = await welt.http.post(`${API}/conversations/${gruppe.id}/messages`, {
      headers: als(a),
      data: { type: 'text', body: 'Hallo zusammen', clientId: `sync-${Date.now()}` },
    });
    expect(gesendet.ok()).toBeTruthy();

    const seiteC = await welt.seite(c);
    await seiteC.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    await expect(seiteC.getByText('Termin nicht verfügbar.')).toBeVisible({ timeout: 15_000 });
    await expect(seiteC.getByText('Hallo zusammen')).toHaveCount(1);

    // A lädt C wieder ein. C hat den Gruppenchat die ganze Zeit offen: Die leere Karte
    // füllt sich ohne Zutun, und der Verlauf steht danach genau einmal da.
    const wieder = await welt.http.patch(`${API}/calendar/events/${termin.id}`, {
      headers: als(a),
      data: {
        attendeeIds: [b.user.id, c.user.id, d.user.id],
        zustellung: { senden: true, einzelchats: true },
      },
    });
    expect(wieder.ok()).toBeTruthy();
    const karte = seiteC.locator('.cal-bubble').filter({ hasText: termin.titel });
    await expect(karte).toBeVisible({ timeout: 15_000 });
    await expect(seiteC.getByText('Termin nicht verfügbar.')).toHaveCount(0);
    await expect(seiteC.getByText('Hallo zusammen')).toHaveCount(1);

    // Aus dem Chat heraus und wieder hinein: kein doppelter Verlauf, jede Zeile einmal.
    await seiteC.getByLabel('Zurück zu den Chats').click();
    await expect(seiteC.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await seiteC.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
    await expect(karte).toBeVisible({ timeout: 15_000 });
    await seiteC.waitForTimeout(1500);
    await expect(seiteC.getByText('Hallo zusammen')).toHaveCount(1);
    await expect(karte).toHaveCount(1);
    const kennungen = await seiteC
      .locator('.msg-row')
      .evaluateAll((zeilen) => zeilen.map((zeile) => zeile.getAttribute('data-message-id')));
    expect(new Set(kennungen).size, 'jede Nachricht genau einmal').toBe(kennungen.length);
  });

  test('eine Karte hinter der ersten Seite zeigt nach dem App-Neustart den Stand vom Server', async ({
    welt,
  }) => {
    const { a, b, c, d, gruppe } = welt;
    const termin = await welt.terminAnlegen(a, {
      personen: [b, c, d],
      gruppen: [gruppe.id],
      einzelchats: false,
    });

    // B öffnet den Chat einmal (füllt den Zwischenspeicher) und schließt die App.
    const seiteB = await welt.seite(b);
    await seiteB.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: termin.titel })).toContainText(
      '1 zugesagt',
      { timeout: 15_000 },
    );
    // Der Zwischenspeicher schreibt im Hintergrund: ihm einen Augenblick lassen.
    await seiteB.waitForTimeout(1500);
    const kontext = seiteB.context();
    await seiteB.close();

    // Währenddessen kommen 60 Nachrichten hinter die Karte, und C sagt zu.
    for (let nummer = 0; nummer < 60; nummer += 1) {
      await welt.http.post(`${API}/conversations/${gruppe.id}/messages`, {
        headers: als(a),
        data: { type: 'text', body: `Zeile ${nummer}`, clientId: `sync-${Date.now()}-${nummer}` },
      });
    }
    await welt.zusagen(c, termin, 'yes');

    // B startet die App neu: Die erste Seite (50) kommt frisch, die Karte liegt dahinter.
    const neu = await kontext.newPage();
    await neu.goto(`${welt.wurzel}/chats/${gruppe.id}`);
    await expect(neu.getByText('Zeile 59')).toBeVisible({ timeout: 15_000 });
    await expect(neu.locator('.cal-bubble').filter({ hasText: termin.titel })).toContainText(
      '2 zugesagt',
      { timeout: 15_000 },
    );
  });

  test('eine späte Antwort belebt einen eben gelöschten Termin nicht wieder', async ({ welt }) => {
    const { a, b } = welt;
    const termin = await welt.terminAnlegen(a, { personen: [b] });
    const seiteB = await welt.seite(b);
    const abB = await welt.einzelchat(b, a);
    await seiteB.goto(`${welt.wurzel}/chats/${abB!.id}`);
    await expect(seiteB.locator('.cal-bubble').filter({ hasText: termin.titel })).toBeVisible({
      timeout: 15_000,
    });
    await seiteB.waitForTimeout(2500); // Der Websocket steht.

    // Die Terminseite lädt den Termin selbst; die Antwort kommt erst nach drei Sekunden
    // (Mobilfunk).
    await seiteB.route(new RegExp(`/calendar/events/${termin.id}$`), async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const antwort = await route.fetch();
      await new Promise((fertig) => setTimeout(fertig, 3000));
      return route.fulfill({ response: antwort });
    });
    await seiteB.evaluate((id) => {
      window.history.pushState({}, '', `/kalender/termin/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, termin.id);
    await seiteB.waitForTimeout(800);

    // Mitten in der Wartezeit löscht A den Termin.
    const geloescht = await welt.http.delete(`${API}/calendar/events/${termin.id}`, {
      headers: als(a),
    });
    expect(geloescht.ok()).toBeTruthy();
    await expect(seiteB.getByText('Termin gelöscht')).toBeVisible({ timeout: 10_000 });

    // Auch nachdem die späte Antwort da ist, bleibt er gelöscht – ohne Zusage-Knöpfe.
    await seiteB.waitForTimeout(4000);
    await expect(seiteB.getByText('Termin gelöscht')).toBeVisible();
    await expect(seiteB.getByRole('button', { name: 'Zusagen' })).toHaveCount(0);
  });
});
