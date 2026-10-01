import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Prüfer: Synchronität im Browser.
 *  H1  Verbindungsabbruch: eine Zusage in der Lücke erreicht die Karte nach dem Wiederverbinden nicht.
 *  H2  Wieder eingeladen, Gruppenchat offen: die leere Karte füllt sich nicht.
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
    data: { username: `${prefix}${suffix}`, password: 'passwort123', displayName: `${prefix.toUpperCase()} ${suffix}` },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

/** Eine Seite, deren Websocket sich gezielt unterbrechen lässt. */
async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string, schalter: { luecke: boolean; aktuell: { close: () => void } | null }): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.routeWebSocket(/\/ws/, (ws) => {
    if (schalter.luecke) {
      ws.close({ code: 1006 });
      return;
    }
    const server = ws.connectToServer();
    if (process.env.WS_LOG) console.log('  [ws] verbunden', new Date().toISOString());
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (process.env.WS_LOG) console.log('  [ws] <-', String(m).slice(0, 90), new Date().toISOString());
      ws.send(m);
    });
    server.onClose(() => ws.close());
    ws.onClose(() => server.close());
    schalter.aktuell = { close: () => ws.close({ code: 1006 }) };
  });
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

const als = (s: Sitzung) => ({ authorization: `Bearer ${s.accessToken}` });

async function imAppWeg(page: Page, pfad: string) {
  await page.evaluate((ziel) => {
    window.history.pushState({}, '', ziel);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, pfad);
}

test('H1: Zusage während eines Verbindungsabbruchs erreicht die Karte nicht mehr', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pha');
  const b = await registrieren(http, 'phb');
  const c = await registrieren(http, 'phc');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PH', memberIds: [b.user.id, c.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const titel = `Lücke ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: [b.user.id, c.user.id],
        zustellung: { senden: true, einzelchats: false, gruppenChatIds: [gruppe.id] },
      },
    })
  ).json();

  const schalter = { luecke: false, aktuell: null as { close: () => void } | null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.goto(`${wurzel}/chats/${gruppe.id}`);
  const karte = seiteB.locator('.cal-bubble').filter({ hasText: titel });
  await expect(karte).toContainText('1 zugesagt', { timeout: 15_000 });

  // Die Leitung reisst ab (Tunnel, Bildschirm aus), und solange sie weg ist, sagt C zu.
  schalter.luecke = true;
  schalter.aktuell?.close();
  await seiteB.waitForTimeout(1500);
  const zusage = await http.post(`${API}/calendar/events/${termin.id}/rsvp`, { headers: als(c), data: { status: 'yes' } });
  expect(zusage.ok()).toBeTruthy();
  const serverSicht = await (await http.get(`${API}/calendar/events/${termin.id}`, { headers: als(b) })).json();
  console.log('Server: yes =', serverSicht.attendees.filter((x: { status: string }) => x.status === 'yes').length);

  // Die Leitung steht wieder.
  schalter.luecke = false;
  await expect.poll(() => schalter.aktuell !== null, { timeout: 30_000 }).toBeTruthy();
  await seiteB.waitForTimeout(8000);
  const nachWiederverbinden = (await karte.innerText()).replace(/\s+/g, ' ');
  console.log('Karte nach Wiederverbinden:', nachWiederverbinden);

  // Aus dem Chat heraus und wieder hinein (ohne Neuladen der Seite).
  await seiteB.getByLabel('Zurück zu den Chats').click();
  await expect(seiteB.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteB.waitForTimeout(3000);
  const nachWiedereintritt = (await seiteB.locator('.cal-bubble').filter({ hasText: titel }).innerText()).replace(/\s+/g, ' ');
  console.log('Karte nach Wiedereintritt in den Chat:', nachWiedereintritt);

  await seiteB.reload();
  await expect(seiteB.locator('.cal-bubble').filter({ hasText: titel })).toBeVisible({ timeout: 15_000 });
  await seiteB.waitForTimeout(2000);
  console.log('Karte nach Neuladen:', (await seiteB.locator('.cal-bubble').filter({ hasText: titel }).innerText()).replace(/\s+/g, ' '));
  await http.dispose();
});

test('H2: wieder eingeladen, Gruppenchat offen: die leere Karte bleibt leer', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pia');
  const b = await registrieren(http, 'pib');
  const c = await registrieren(http, 'pic');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PI', memberIds: [b.user.id, c.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const titel = `Wieder ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: [b.user.id, c.user.id],
        zustellung: { senden: true, einzelchats: true, gruppenChatIds: [gruppe.id] },
      },
    })
  ).json();
  // C wird ausgeladen, BEVOR C die App öffnet: Die Gruppenkarte kommt für C ohne Termin und ohne Kennung.
  const aus = await http.delete(`${API}/calendar/events/${termin.id}/attendees/${c.user.id}`, { headers: als(a) });
  expect(aus.ok()).toBeTruthy();

  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Hallo zusammen', clientId: `pi-${Date.now()}` } });
  const schalter = { luecke: false, aktuell: null };
  const seiteC = await seiteFuer(browser, c, wurzel, schalter);
  await seiteC.goto(`${wurzel}/chats/${gruppe.id}`);
  await expect(seiteC.getByText('Termin nicht verfügbar.')).toBeVisible({ timeout: 15_000 });

  // A lädt C wieder ein. C hat den Gruppenchat die ganze Zeit offen.
  const wieder = await http.patch(`${API}/calendar/events/${termin.id}`, {
    headers: als(a),
    data: { attendeeIds: [b.user.id, c.user.id], zustellung: { senden: true, einzelchats: true } },
  });
  expect(wieder.ok()).toBeTruthy();
  await seiteC.waitForTimeout(4000);
  const sichtbar = await seiteC.locator('.cal-bubble').allInnerTexts();
  console.log('C, Gruppenchat offen, nach erneuter Einladung:', JSON.stringify(sichtbar));
  const gruppenkarteC = await (await http.get(`${API}/conversations/${gruppe.id}/messages`, { headers: als(c) })).json();
  console.log('Server liefert C jetzt in der Gruppenkarte:', JSON.stringify(gruppenkarteC.items.filter((m: { type: string }) => m.type === 'event').map((m: { event?: { title: string } }) => m.event?.title ?? null)));

  // Nach erneutem Betreten stimmt es (echte Navigation: zurück zur Liste, Zeile antippen).
  await seiteC.getByLabel('Zurück zu den Chats').click();
  await expect(seiteC.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await seiteC.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteC.waitForTimeout(3000);
  console.log('Zeilen nach echter Navigation:', JSON.stringify(await seiteC.locator('.msg-row').evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText.replace(/\\s+/g, ' ').slice(14, 50)))));
  const gerueste = await seiteC.locator('.msg-row').evaluateAll((els) => els.map((el) => { const pfad: string[] = []; let p: HTMLElement | null = el as HTMLElement; for (let i = 0; i < 12 && p && p.tagName !== 'BODY'; i += 1, p = p.parentElement) pfad.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).split(' ')[0] : '')); return pfad.join(' < '); }));
  console.log('Textnachrichten im DOM:', await seiteC.getByText('Hallo zusammen').count());
  console.log('Gerüst:', JSON.stringify(gerueste, null, 1));
  const speicher = await seiteC.evaluate(async (chat) => {
    const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => /\/src\/state\/chat\.ts/.test(n)) ?? '/src/state/chat.ts';
    const m = await import(/* @vite-ignore */ url);
    const st = m.useChat.getState();
    return { loaded: st.loaded[chat], loading: st.loading[chat], liste: (st.messages[chat] ?? []).map((x: any) => [x.id.slice(-4), x.type, x.clientId ?? null, Boolean(x.event), JSON.stringify(x.metadata), x.terminGrund ?? null]) };
  }, gruppe.id);
  console.log('Speicher:', JSON.stringify(speicher));
  console.log('C nach Wiederbetreten:', JSON.stringify(await seiteC.locator('.cal-bubble').allInnerTexts()));
  const zeilen = await seiteC.locator('.msg-row').evaluateAll((els) => els.map((el) => [el.getAttribute('data-message-id'), (el as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 60)]));
  console.log('Zeilen:', JSON.stringify(zeilen, null, 1));
  const alleNachrichten = await (await http.get(`${API}/conversations/${gruppe.id}/messages`, { headers: als(c) })).json();
  console.log('Server C:', JSON.stringify(alleNachrichten.items.map((m: { id: string; type: string; deletedAt: string | null; event?: unknown }) => [m.id, m.type, m.deletedAt, Boolean(m.event)])));
  await http.dispose();
});

test('H3: loadMessages(force) auf einem geladenen Chat (Weg des sync.hint) verdoppelt die Anzeige', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pka');
  const b = await registrieren(http, 'pkb');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PK', memberIds: [b.user.id] } })
  ).json();
  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Erste Zeile', clientId: `pk-${Date.now()}` } });
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.goto(`${wurzel}/chats`);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await expect(seiteB.getByText('Erste Zeile')).toHaveCount(1, { timeout: 15_000 });
  // So lädt der Client nach einem sync.hint mit conversationId nach (state/chat.ts, Handler 'sync.hint').
  await seiteB.evaluate(async (chat) => {
    const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => /\/src\/state\/chat\.ts/.test(n)) ?? '/src/state/chat.ts';
    const m = await import(/* @vite-ignore */ url);
    await m.useChat.getState().loadMessages(chat, { force: true });
  }, gruppe.id);
  await seiteB.waitForTimeout(2000);
  console.log('H3: "Erste Zeile" im DOM nach loadMessages(force):', await seiteB.getByText('Erste Zeile').count());
  await http.dispose();
});

test('H3b: geladener Chat, loaded zurückgesetzt, Chat verlassen und wieder betreten', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pla');
  const b = await registrieren(http, 'plb');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PL', memberIds: [b.user.id] } })
  ).json();
  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Erste Zeile', clientId: `pl-${Date.now()}` } });
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.goto(`${wurzel}/chats`);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await expect(seiteB.getByText('Erste Zeile')).toHaveCount(1, { timeout: 15_000 });
  await seiteB.getByLabel('Zurück zu den Chats').click();
  await expect(seiteB.getByRole('heading', { name: 'Chats' })).toBeVisible();
  // Genau das tut terminAbgleichen bei einer „leeren Karte“ (state/chat.ts:587).
  await seiteB.evaluate(async (chat) => {
    const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => /\/src\/state\/chat\.ts/.test(n)) ?? '/src/state/chat.ts';
    const m = await import(/* @vite-ignore */ url);
    m.useChat.setState((s: { loaded: Record<string, boolean> }) => ({ loaded: { ...s.loaded, [chat]: false } }));
  }, gruppe.id);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteB.waitForTimeout(3000);
  console.log('H3b: "Erste Zeile" im DOM nach Wiederbetreten bei loaded=false:', await seiteB.getByText('Erste Zeile').count());
  await http.dispose();
});

test('H4: Karte weiter oben im Verlauf (hinter der ersten Seite) bleibt nach App-Neustart veraltet', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pma');
  const b = await registrieren(http, 'pmb');
  const c = await registrieren(http, 'pmc');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PM', memberIds: [b.user.id, c.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const titel = `Alt im Verlauf ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: [b.user.id, c.user.id],
        zustellung: { senden: true, einzelchats: false, gruppenChatIds: [gruppe.id] },
      },
    })
  ).json();

  // B öffnet den Chat einmal (füllt den Zwischenspeicher) und schließt die App.
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.goto(`${wurzel}/chats/${gruppe.id}`);
  await expect(seiteB.locator('.cal-bubble').filter({ hasText: titel })).toContainText('1 zugesagt', { timeout: 15_000 });
  const kontext = seiteB.context();
  await seiteB.close();

  // Währenddessen: 60 Nachrichten hinter der Karte, und C sagt zu.
  for (let i = 0; i < 60; i += 1) {
    await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: `Zeile ${i}`, clientId: `pm-${Date.now()}-${i}` } });
  }
  const zusage = await http.post(`${API}/calendar/events/${termin.id}/rsvp`, { headers: als(c), data: { status: 'yes' } });
  expect(zusage.ok()).toBeTruthy();
  const serverSicht = await (await http.get(`${API}/calendar/events/${termin.id}`, { headers: als(b) })).json();
  console.log('H4 Server: zugesagt =', serverSicht.attendees.filter((x: { status: string }) => x.status === 'yes').length);

  // B startet die App neu und öffnet den Chat; die Karte liegt hinter der ersten Seite (50).
  const neu = await kontext.newPage();
  await neu.goto(`${wurzel}/chats/${gruppe.id}`);
  await expect(neu.getByText('Zeile 59')).toBeVisible({ timeout: 15_000 });
  const karte = neu.locator('.cal-bubble').filter({ hasText: titel });
  await karte.scrollIntoViewIfNeeded().catch(() => {});
  await neu.waitForTimeout(2000);
  console.log('H4 Karte im Chat nach Neustart:', (await karte.count()) === 0 ? '(nicht im DOM)' : (await karte.first().innerText()).replace(/\s+/g, ' '));
  await http.dispose();
});

test('H5: eine langsame Nachrichtenliste überschreibt die neuere Fassung der Karte', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pna');
  const b = await registrieren(http, 'pnb');
  const c = await registrieren(http, 'pnc');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PN', memberIds: [b.user.id, c.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const titel = `Langsam ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: [b.user.id, c.user.id],
        zustellung: { senden: true, einzelchats: false, gruppenChatIds: [gruppe.id] },
      },
    })
  ).json();
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.goto(`${wurzel}/chats/${gruppe.id}`);
  await expect(seiteB.locator('.cal-bubble').filter({ hasText: titel })).toContainText('1 zugesagt', { timeout: 15_000 });
  await seiteB.goto(`${wurzel}/chats`);

  // Die Liste kommt langsam (Mobilfunk): Der Server hat sie schon gerechnet, die Antwort braucht drei Sekunden.
  await seiteB.route(new RegExp(`/conversations/${gruppe.id}/messages`), async (route) => {
    const antwort = await route.fetch();
    await new Promise((f) => setTimeout(f, 3000));
    await route.fulfill({ response: antwort });
  });
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteB.waitForTimeout(800);
  // Mitten in der Wartezeit sagt C zu: Der Rundruf ist schneller als die Liste.
  const zusage = await http.post(`${API}/calendar/events/${termin.id}/rsvp`, { headers: als(c), data: { status: 'yes' } });
  expect(zusage.ok()).toBeTruthy();
  const karte = seiteB.locator('.cal-bubble').filter({ hasText: titel });
  await seiteB.waitForTimeout(1000);
  console.log('H5 Karte vor Eintreffen der Liste:', (await karte.first().innerText()).replace(/\s+/g, ' ').slice(0, 90));
  await seiteB.waitForTimeout(4500);
  console.log('H5 Karte nach Eintreffen der Liste:', (await karte.first().innerText()).replace(/\s+/g, ' ').slice(0, 90));
  await http.dispose();
});

test('H6: Nachricht kommt live, solange der Chat nicht offen ist; danach öffnen', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'poa');
  const b = await registrieren(http, 'pob');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PO', memberIds: [b.user.id] } })
  ).json();
  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Alt A', clientId: `po-${Date.now()}-1` } });
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  // B hat den Chat schon einmal geöffnet (Zwischenspeicher gefüllt) und ist zurück in der Liste.
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await expect(seiteB.getByText('Alt A')).toHaveCount(1, { timeout: 15_000 });
  await seiteB.getByLabel('Zurück zu den Chats').click();
  await expect(seiteB.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Neu B', clientId: `po-${Date.now()}-2` } });
  await seiteB.waitForTimeout(1000);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteB.waitForTimeout(2500);
  console.log('H6: "Alt A" im DOM:', await seiteB.getByText('Alt A').count(), ' "Neu B":', await seiteB.getByText('Neu B').count());

  // Und die Variante: Seite neu geladen, Liste offen, Nachricht kommt, Chat öffnen.
  await seiteB.goto(`${wurzel}/chats`);
  await expect(seiteB.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await http.post(`${API}/conversations/${gruppe.id}/messages`, { headers: als(a), data: { type: 'text', body: 'Neu C', clientId: `po-${Date.now()}-3` } });
  await seiteB.waitForTimeout(1500);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  await seiteB.waitForTimeout(2500);
  console.log('H6b: "Alt A":', await seiteB.getByText('Alt A').count(), ' "Neu B":', await seiteB.getByText('Neu B').count(), ' "Neu C":', await seiteB.getByText('Neu C').count());
  await http.dispose();
});

test('H7: eine langsame Antwort holt einen gerade gelöschten Termin auf der Terminseite zurück', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const wurzel = baseURL ?? 'http://localhost:5183';
  const a = await registrieren(http, 'pqa');
  const b = await registrieren(http, 'pqb');
  const gruppe = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'PQ', memberIds: [b.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const titel = `Zombie ${Date.now()}`;
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: [b.user.id],
        zustellung: { senden: true, einzelchats: false, gruppenChatIds: [gruppe.id] },
      },
    })
  ).json();
  const schalter = { luecke: false, aktuell: null };
  const seiteB = await seiteFuer(browser, b, wurzel, schalter);
  await seiteB.locator(`a.chat-row[href="/chats/${gruppe.id}"]`).click();
  const karte = seiteB.locator('.cal-bubble').filter({ hasText: titel });
  await expect(karte).toBeVisible({ timeout: 15_000 });
  await seiteB.waitForTimeout(2500); // Websocket steht sicher

  // Die Terminseite lädt den Termin selbst (Antwort kommt nach drei Sekunden).
  if (process.env.H7_KONTROLLE) {
    await seiteB.evaluate((id) => {
      window.history.pushState({}, '', `/kalender/termin/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, termin.id);
    await expect(seiteB.getByText(titel).first()).toBeVisible({ timeout: 15_000 });
    await http.delete(`${API}/calendar/events/${termin.id}`, { headers: als(a) });
    await seiteB.waitForTimeout(2000);
    console.log('H7 Kontrolle (ohne Verzögerung):', (await seiteB.locator('main, .app-main').first().innerText()).replace(/\s+/g, ' ').slice(0, 120));
    return;
  }
  await seiteB.route(new RegExp(`/calendar/events/${termin.id}$`), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const antwort = await route.fetch();
    await new Promise((f) => setTimeout(f, 3000));
    await route.fulfill({ response: antwort });
  });
  // Terminseite per Link in der App öffnen: `useLiveEvent` startet ohne Vorbelegung eine eigene Abfrage.
  await seiteB.evaluate((id) => {
    window.history.pushState({}, '', `/kalender/termin/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, termin.id);
  await seiteB.waitForTimeout(800);
  const del = await http.delete(`${API}/calendar/events/${termin.id}`, { headers: als(a) });
  expect(del.ok()).toBeTruthy();
  await seiteB.waitForTimeout(1200);
  console.log('H7 vor Eintreffen der Antwort:', (await seiteB.locator('main, .app-main').first().innerText()).replace(/\s+/g, ' ').slice(0, 120));
  await seiteB.waitForTimeout(3500);
  console.log('H7 nach Eintreffen der Antwort:', (await seiteB.locator('main, .app-main').first().innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await http.dispose();
});
