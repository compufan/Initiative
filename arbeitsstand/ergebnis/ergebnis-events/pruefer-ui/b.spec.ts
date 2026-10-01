import { expect, request, test, type Page, type Browser } from '@playwright/test';
import { API } from './lib';

test.describe.configure({ mode: 'serial' });

const OUT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pruefer-ui/';

interface Sitz { accessToken: string; refreshToken: string; user: { id: string; displayName: string; username: string } }

async function anmelden(): Promise<Sitz> {
  const http = await request.newContext();
  const r = await http.post(`${API}/auth/login`, { data: { username: process.env.PRU_USER, password: 'passwort123' } });
  expect(r.ok(), `login ${r.status()}`).toBeTruthy();
  const s = await r.json();
  await http.dispose();
  return s;
}

function fake(i: number, name?: string, nutzer?: string) {
  const id = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
  return {
    userId: id, role: 'member', joinedAt: '2026-10-01T00:00:00Z', nickname: null, lastReadMessageId: null, siehtAb: '2026-10-01T00:00:00Z',
    user: { id, username: nutzer ?? `fake${i}`, displayName: name ?? `Person ${String(i).padStart(3, '0')}`, avatarUrl: null, bio: null, accent: '#22c55e', lastSeenAt: null, createdAt: '2026-10-01T00:00:00Z' },
  };
}

async function seite(browser: Browser, s: Sitz, viewport: { width: number; height: number }, mocken: (items: any[], me: Sitz) => void): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.route(/\/api\/v1\/conversations(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const antwort = await route.fetch();
    const json = await antwort.json();
    mocken(json.items, s);
    await route.fulfill({ response: antwort, json });
  });
  await page.goto('http://localhost:5183/');
  await page.evaluate((w) => localStorage.setItem('initiative.tokens', JSON.stringify(w)), {
    accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: Date.now() + 3_600_000,
  });
  await page.goto('http://localhost:5183/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

function gruppeMit(me: Sitz, titel: string, mitglieder: any[], id: string) {
  const ich = { userId: me.user.id, role: 'owner', joinedAt: '2026-10-01T00:00:00Z', nickname: null, lastReadMessageId: null, siehtAb: '2026-10-01T00:00:00Z', user: { id: me.user.id, username: me.user.username, displayName: me.user.displayName, avatarUrl: null, bio: null, accent: '#22c55e', lastSeenAt: null, createdAt: '2026-10-01T00:00:00Z' } };
  return {
    id, type: 'group', title: titel, avatarUrl: null, createdBy: me.user.id, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    members: [ich, ...mitglieder], lastMessage: null, unreadCount: 0, verdeckterVerlauf: false, mutedUntil: null, archived: false,
  };
}

const blatt = (s: Page) => s.getByRole('dialog');

test('P5 viele Personen (180): Darstellung, Alle, Tick-Zeit', async ({ browser }) => {
  const me = await anmelden();
  const viele = Array.from({ length: 180 }, (_, i) => fake(i + 1));
  const s = await seite(browser, me, { width: 375, height: 760 }, (items, m) =>
    items.unshift(gruppeMit(m, 'Grosse Runde', viele, '00000000-0000-7000-9000-000000000001')),
  );
  await s.goto('http://localhost:5183/kalender');
  await s.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(s)).toBeVisible();
  const liste = blatt(s).getByRole('group', { name: 'Personen', exact: true });
  await expect(liste.getByRole('checkbox').first()).toBeVisible({ timeout: 15_000 });
  console.log('P5 Zeilen gerendert:', await liste.getByRole('checkbox').count());
  console.log('P5 Weitere-Knopf:', await blatt(s).getByRole('button', { name: /Weitere anzeigen/ }).innerText());
  const zaehler = blatt(s).getByRole('status').filter({ hasText: /^\d+ von \d+ Personen?$/ });
  console.log('P5 Zähler:', await zaehler.innerText());
  // Zeit bis Zähler nach Alle
  const t0 = Date.now();
  await blatt(s).getByRole('button', { name: 'Alle Kontakte einladen' }).click();
  await expect(zaehler).toHaveText('181 von 181 Personen');
  console.log('P5 Alle -> Zähler ms:', Date.now() - t0);
  // Tick-Zeit
  const zeiten: number[] = [];
  for (let i = 0; i < 5; i++) {
    const cb = liste.getByRole('checkbox').nth(i);
    const t = await s.evaluate(async (idx) => {
      const boxes = document.querySelectorAll('.cal-einl-liste input[type=checkbox]');
      const start = performance.now();
      (boxes[idx] as HTMLInputElement).click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - start;
    }, i);
    zeiten.push(Math.round(t));
    void cb;
  }
  console.log('P5 Tick bis 2 Frames (ms):', zeiten.join(','));
  // Anzahl DOM-Knoten
  console.log('P5 DOM-Knoten im Blatt:', await s.evaluate(() => document.querySelector('[role=dialog]')!.querySelectorAll('*').length));
  await s.screenshot({ path: OUT + 'p5-375.png' });
  await s.context().close();
});

test('P5b über 200 Kontakte: Alle gesperrt', async ({ browser }) => {
  const me = await anmelden();
  const viele = Array.from({ length: 230 }, (_, i) => fake(i + 1));
  const s = await seite(browser, me, { width: 375, height: 760 }, (items, m) =>
    items.unshift(gruppeMit(m, 'Riesenrunde', viele, '00000000-0000-7000-9000-000000000002')),
  );
  await s.goto('http://localhost:5183/kalender');
  await s.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(s)).toBeVisible();
  await expect(blatt(s).getByRole('button', { name: 'Alle Kontakte einladen' })).toBeVisible({ timeout: 15_000 });
  console.log('P5b Alle disabled:', await blatt(s).getByRole('button', { name: 'Alle Kontakte einladen' }).isDisabled());
  // Gruppe mit 230 Mitgliedern
  await blatt(s).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(s).getByRole('button', { name: /Riesenrunde/ }).click();
  console.log('P5b Meldung:', await blatt(s).getByRole('alert').allInnerTexts());
  // Einzeln 201 anhaken ist möglich?
  const n = await s.evaluate(async () => {
    const boxes = Array.from(document.querySelectorAll('.cal-einl-liste input[type=checkbox]')) as HTMLInputElement[];
    return boxes.length;
  });
  console.log('P5b sichtbare Kästchen', n);
  await s.context().close();
});

test('P6 375 px, lange Namen: kein Überlauf', async ({ browser }) => {
  const me = await anmelden();
  const lang = 'Maximilian-Alexander-Christoph-von-und-zu-Hohenlohe-Schillingsfürst';
  const mitglieder = [
    fake(1, lang, 'm'.repeat(30)),
    fake(2, 'Anna Adler'),
    fake(3, 'Ben Braun'),
    fake(4, 'Dora Dietrich'),
  ];
  const titel = 'Die allerlängste Gruppenbezeichnung der Welt für unseren Skatabend am Donnerstag';
  const s = await seite(browser, me, { width: 375, height: 760 }, (items, m) => {
    items.unshift(gruppeMit(m, titel, mitglieder, '00000000-0000-7000-9000-000000000003'));
    items.unshift(gruppeMit(m, 'Familie', mitglieder.slice(1, 3), '00000000-0000-7000-9000-000000000004'));
    items.unshift(gruppeMit(m, 'Familie', mitglieder.slice(1, 3), '00000000-0000-7000-9000-000000000005'));
  });
  await s.goto('http://localhost:5183/kalender');
  await s.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(s)).toBeVisible();
  await blatt(s).getByRole('button', { name: 'Alle Kontakte einladen' }).click();
  await blatt(s).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(s).getByRole('group', { name: 'Gruppenchat wählen' }).getByRole('button', { name: /Die allerlängste/ }).click();
  await blatt(s).getByRole('checkbox', { name: /Ben Braun/ }).uncheck();
  const ueberlauf = await s.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]') as HTMLElement;
    const grenze = window.innerWidth;
    const bad: string[] = [];
    dlg.querySelectorAll('*').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && (r.right > grenze + 0.5 || r.left < -0.5)) bad.push(`${el.tagName}.${(el as HTMLElement).className}: ${Math.round(r.left)}..${Math.round(r.right)} "${(el.textContent ?? '').slice(0, 30)}"`);
    });
    return { seitenBreite: document.documentElement.scrollWidth, innen: window.innerWidth, dlg: dlg.scrollWidth, dlgClient: dlg.clientWidth, bad: bad.slice(0, 15) };
  });
  console.log('P6 Überlauf:', JSON.stringify(ueberlauf, null, 1));
  await s.screenshot({ path: OUT + 'p6-375.png' });
  await blatt(s).getByRole('group', { name: 'Personen', exact: true }).scrollIntoViewIfNeeded();
  await s.screenshot({ path: OUT + 'p6-375-b.png' });
  // zwei Gruppen mit gleichem Titel
  await blatt(s).getByRole('button', { name: 'Niemand einladen' }).click();
  await blatt(s).getByRole('button', { name: /Gruppenchat …/ }).click();
  const fam = blatt(s).getByRole('group', { name: 'Gruppenchat wählen' }).getByRole('button', { name: /Familie/ });
  console.log('P6 Familie-Knöpfe:', await fam.count());
  const logs: string[] = [];
  s.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 160)); });
  await fam.nth(0).click();
  await blatt(s).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(s).getByRole('group', { name: 'Gruppenchat wählen' }).getByRole('button', { name: /Familie/ }).nth(1).click();
  const v = blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
  console.log('P6 Vorschau bei zwei Familie-Chats:', JSON.stringify(await v.innerText()));
  console.log('P6 Konsole:', JSON.stringify(logs));
  await s.context().close();
});
