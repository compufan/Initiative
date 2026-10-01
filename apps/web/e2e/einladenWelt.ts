import {
  expect,
  request,
  test as basis,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Die gemeinsame Welt der Einlade-Tests: Konten, ein Gruppenchat, Browser.
 *
 * Jeder Test bekommt seine **eigene** Welt – frische Konten, eigener Gruppenchat,
 * eigene Browser. Früher bauten die Tests aufeinander auf (Termin 1 und 2 lebten
 * durch die ganze Datei): Ein einzelner Test ließ sich nicht allein laufen, ein
 * früher Fehler verdeckte alle folgenden, und im CI lief nach einem Fehlschlag die
 * ganze Reihe samt Konten ein zweites Mal. Was ein Test braucht, legt er jetzt
 * selbst an, am einfachsten über die API (`terminAnlegen`) – im Browser wird nur
 * geprüft, was der Test prüfen will.
 *
 * Fünf Rollen: **A** legt Termine an, **B**, **C** und **D** sitzen mit A in einem
 * Gruppenchat, **E** (`fremder()`) kennt niemand. Jedes Konto hat seinen eigenen
 * Browser, damit das Echtzeit-Verhalten wirklich über den Server läuft und nicht
 * über einen gemeinsamen Speicher.
 */

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
export const API = `${API_URL}/api/v1`;

export interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; username: string };
}

export async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
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

export const als = (sitzung: Sitzung) => ({ authorization: `Bearer ${sitzung.accessToken}` });

/** Ein Schalter, mit dem sich die Leitung eines Browsers gezielt unterbrechen lässt. */
export interface Leitung {
  /** Solange `true`, wird jeder neue Websocket sofort wieder geschlossen. */
  luecke: boolean;
  /** Schließt die gerade offene Verbindung (wie ein Funkloch). */
  trennen: () => void;
  /** Wie oft sich der Browser bisher mit dem Server verbunden hat. */
  verbunden: number;
}

export function neueLeitung(): Leitung {
  return { luecke: false, trennen: () => {}, verbunden: 0 };
}

/** Eine Seite mit eingeloggtem Konto – auf Wunsch mit einer Leitung, die sich unterbrechen lässt. */
export async function seiteFuer(
  browser: Browser,
  sitzung: Sitzung,
  wurzel: string,
  leitung?: Leitung,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (leitung) {
    await page.routeWebSocket(/\/ws/, (ws) => {
      if (leitung.luecke) {
        ws.close({ code: 1006 });
        return;
      }
      const server = ws.connectToServer();
      ws.onMessage((nachricht) => server.send(nachricht));
      server.onMessage((nachricht) => ws.send(nachricht));
      server.onClose(() => ws.close());
      ws.onClose(() => server.close());
      leitung.verbunden += 1;
      leitung.trennen = () => ws.close({ code: 1006 });
    });
  }
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

export interface Nachricht {
  id: string;
  type: string;
  metadata: { eventId?: string };
  event?: { title: string };
  deletedAt: string | null;
}

export interface Chat {
  id: string;
  type: string;
  members: { userId: string }[];
}

export interface Termin {
  id: string;
  titel: string;
}

export class Welt {
  readonly seiten = new Map<Sitzung, Page>();
  a!: Sitzung;
  b!: Sitzung;
  c!: Sitzung;
  d!: Sitzung;
  gruppe!: { id: string; title: string };
  private fremd: Sitzung | null = null;

  private constructor(
    readonly browser: Browser,
    readonly http: APIRequestContext,
    readonly wurzel: string,
  ) {}

  static async aufbauen(browser: Browser, baseURL: string | undefined): Promise<Welt> {
    const http = await request.newContext();
    const welt = new Welt(browser, http, baseURL ?? 'http://localhost:5173');
    [welt.a, welt.b, welt.c, welt.d] = await Promise.all([
      registrieren(http, 'einla'),
      registrieren(http, 'einlb'),
      registrieren(http, 'einlc'),
      registrieren(http, 'einld'),
    ]);
    welt.gruppe = await (
      await http.post(`${API}/conversations`, {
        headers: als(welt.a),
        data: {
          type: 'group',
          title: `Skat ${Date.now()}`,
          memberIds: [welt.b.user.id, welt.c.user.id, welt.d.user.id],
        },
      })
    ).json();
    return welt;
  }

  /** Das Konto, das niemand kennt: Es steht in keinem gemeinsamen Chat. */
  async fremder(): Promise<Sitzung> {
    this.fremd ??= await registrieren(this.http, 'einle');
    return this.fremd;
  }

  /** Die Seite eines Kontos – beim ersten Aufruf angelegt und eingeloggt. */
  async seite(sitzung: Sitzung, leitung?: Leitung): Promise<Page> {
    let seite = this.seiten.get(sitzung);
    if (!seite) {
      seite = await seiteFuer(this.browser, sitzung, this.wurzel, leitung);
      this.seiten.set(sitzung, seite);
    }
    return seite;
  }

  async schliessen(): Promise<void> {
    await this.http.dispose();
    for (const seite of this.seiten.values()) await seite.context().close();
  }

  /* ---------- Chats ---------- */

  async chatsVon(sitzung: Sitzung): Promise<Chat[]> {
    const antwort = await this.http.get(`${API}/conversations`, { headers: als(sitzung) });
    return (await antwort.json()).items as Chat[];
  }

  /** Der Einzelchat von `sitzung` mit `andere` – oder `undefined`. */
  async einzelchat(sitzung: Sitzung, andere: Sitzung): Promise<Chat | undefined> {
    return (await this.chatsVon(sitzung)).find(
      (chat) =>
        chat.type === 'direct' &&
        chat.members.some((mitglied) => mitglied.userId === andere.user.id),
    );
  }

  /** Legt den Einzelchat an (oder liefert den vorhandenen). */
  async einzelchatSichern(von: Sitzung, mit: Sitzung): Promise<Chat> {
    const antwort = await this.http.post(`${API}/conversations`, {
      headers: als(von),
      data: { type: 'direct', memberIds: [mit.user.id] },
    });
    expect(antwort.ok(), `Einzelchat: ${antwort.status()}`).toBeTruthy();
    return antwort.json();
  }

  async nachrichten(sitzung: Sitzung, chatId: string): Promise<Nachricht[]> {
    const antwort = await this.http.get(`${API}/conversations/${chatId}/messages`, {
      headers: als(sitzung),
    });
    return (await antwort.json()).items;
  }

  /** Die Karten eines Termins in einem Chat, so wie `sitzung` sie sieht. */
  async karten(sitzung: Sitzung, chatId: string, terminId: string): Promise<Nachricht[]> {
    return (await this.nachrichten(sitzung, chatId)).filter(
      (nachricht) =>
        nachricht.type === 'event' &&
        !nachricht.deletedAt &&
        nachricht.metadata.eventId === terminId,
    );
  }

  /* ---------- Termine ---------- */

  async terminId(sitzung: Sitzung, titel: string): Promise<string> {
    const antwort = await this.http.get(`${API}/calendar/events`, { headers: als(sitzung) });
    const termin = ((await antwort.json()).items as { id: string; title: string }[]).find(
      (eintrag) => eintrag.title === titel,
    );
    expect(termin, `Termin „${titel}“ in der Liste`).toBeTruthy();
    return termin!.id;
  }

  /**
   * Legt einen Termin über die API an – so, wie der Editor es täte: immer mit
   * ausdrücklicher `zustellung`. Die Gruppe bekommt die Karte nur, wenn sie
   * genannt ist und alle ihre Mitglieder eingeladen sind.
   */
  async terminAnlegen(
    ersteller: Sitzung,
    optionen: {
      titel?: string;
      personen: Sitzung[];
      gruppen?: string[];
      einzelchats?: boolean;
      senden?: boolean;
      /** Weitere Felder des Termins, etwa `location`. */
      zusatz?: Record<string, unknown>;
    },
  ): Promise<Termin> {
    const titel = optionen.titel ?? `Termin ${Math.random().toString(36).slice(2, 8)}`;
    const beginn = new Date(Date.now() + 5 * 86_400_000);
    const antwort = await this.http.post(`${API}/calendar/events`, {
      headers: als(ersteller),
      data: {
        title: titel,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
        attendeeIds: optionen.personen.map((person) => person.user.id),
        zustellung: {
          senden: optionen.senden ?? true,
          einzelchats: optionen.einzelchats ?? true,
          gruppenChatIds: optionen.gruppen ?? [],
        },
        ...optionen.zusatz,
      },
    });
    expect(antwort.ok(), `Termin anlegen: ${antwort.status()}`).toBeTruthy();
    return { id: (await antwort.json()).id, titel };
  }

  async zusagen(sitzung: Sitzung, termin: Termin, status: 'yes' | 'no' | 'maybe'): Promise<void> {
    const antwort = await this.http.post(`${API}/calendar/events/${termin.id}/rsvp`, {
      headers: als(sitzung),
      data: { status },
    });
    expect(antwort.ok(), `Zusage: ${antwort.status()}`).toBeTruthy();
  }

  async ausladen(ersteller: Sitzung, termin: Termin, person: Sitzung): Promise<void> {
    const antwort = await this.http.delete(
      `${API}/calendar/events/${termin.id}/attendees/${person.user.id}`,
      { headers: als(ersteller) },
    );
    expect(antwort.ok(), `Ausladen: ${antwort.status()}`).toBeTruthy();
  }
}

/** Jeder Test bekommt seine eigene Welt. */
export const test = basis.extend<{ welt: Welt }>({
  welt: async ({ browser, baseURL }, use) => {
    const welt = await Welt.aufbauen(browser, baseURL);
    try {
      await use(welt);
    } finally {
      await welt.schliessen();
    }
  },
});

export { expect };
