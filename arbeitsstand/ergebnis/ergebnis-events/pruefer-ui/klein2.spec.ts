import { expect, request, test, type Page } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

test('K2: Terminseite „Einladen“ ignoriert zustellung.ausstehend; Rollen der Live-Regionen', async ({ browser }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'la', 'Lea Ersteller');
  const k1 = await registrieren(http, 'lk1', 'Kontakt Eins');
  const k2 = await registrieren(http, 'lk2', 'Kontakt Zwei');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Kleine Gruppe', memberIds: [k1.user.id, k2.user.id] } });
  const t = Date.now() + 86_400_000;
  const m = t - (t % 60000);
  const e1 = await (await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'L1', startsAt: new Date(m).toISOString(), endsAt: new Date(m + 3_600_000).toISOString(), attendeeIds: [k1.user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] }, clientId: 'l1' + t } })).json();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183', 375, 812);
  await seite.route(new RegExp(`/calendar/events/${e1.id}$`), async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const antwort = await route.fetch();
    const json = await antwort.json();
    json.zustellung = { ...(json.zustellung ?? {}), ausstehend: 1 };
    await route.fulfill({ response: antwort, json });
  });
  await seite.goto(`/kalender/termin/${e1.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await feld.getByRole('checkbox', { name: /Kontakt Zwei/ }).check();
  await feld.getByRole('button', { name: 'Einladen', exact: true }).click();
  await seite.waitForTimeout(1500);
  const toast = await seite.locator('[role=status], [role=alert], .toast').allInnerTexts();
  console.log('K2 Meldungen:', JSON.stringify(toast));
  console.log('K2 Hinweis „nicht zugestellt“ sichtbar:', await seite.getByText('Einladungen nicht zugestellt').count());

  // Rollen der Vorschau
  const info = await feld.locator('.cal-einl-vorschau').evaluate((el) => ({ tag: el.tagName, role: el.getAttribute('role'), kinder: [...el.children].map((c) => c.tagName) }));
  console.log('K2 Vorschau-Element:', JSON.stringify(info));

  // Beschriftung der Anzeige-Knöpfe (nur ab 9 Personen sichtbar) – sichtbarer Text gegen Name
  const k = await seite.evaluate(() => [...document.querySelectorAll('.cal-einl-schnell button, .cal-einl-anzeige button')].map((b) => ({ text: b.textContent?.trim(), label: b.getAttribute('aria-label') })));
  console.log('K2 Knöpfe:', JSON.stringify(k));
});
