import { expect, request, test } from '@playwright/test';

const API = 'http://localhost:8080/api/v1';

async function reg(http: any, prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const r = await http.post(`${API}/auth/register`, {
    data: { username: `${prefix}${suffix}`, password: 'passwort123', displayName: `${prefix} Person ${suffix}` },
  });
  return r.json();
}

test('bilder', async ({ browser }) => {
  const http = await request.newContext();
  const a = await reg(http, 'Anna');
  const others = [];
  for (const n of ['Ben', 'Clara', 'Dora', 'Emil', 'Fritz', 'Gerda', 'Hans', 'Ida', 'Jan', 'Kai']) others.push(await reg(http, n));
  const g = await (await http.post(`${API}/conversations`, { headers: { authorization: `Bearer ${a.accessToken}` }, data: { type: 'group', title: 'Skatrunde', memberIds: others.slice(0, 4).map((o: any) => o.user.id) } })).json();
  await http.post(`${API}/conversations`, { headers: { authorization: `Bearer ${a.accessToken}` }, data: { type: 'group', title: 'Hütte', memberIds: others.slice(2, 8).map((o: any) => o.user.id) } });

  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5183/');
  await page.evaluate((w) => localStorage.setItem('initiative.tokens', JSON.stringify(w)), { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: Date.now() + 3_600_000 });
  await page.goto('http://localhost:5183/kalender');
  await page.getByRole('button', { name: /Neuer Termin/ }).click();
  await page.locator('#cal-title').fill('Grillen im Park');
  await expect(page.getByRole('group', { name: 'Personen', exact: true })).toBeVisible({ timeout: 15000 });
  const dlg = page.getByRole('dialog');
  await dlg.locator('.cal-einl').scrollIntoViewIfNeeded();
  await dlg.locator('.cal-einl').screenshot({ path: 'bilder/1-leer.png' });
  await page.getByRole('button', { name: /Gruppenchat …/ }).click();
  await page.screenshot({ path: 'bilder/2-gruppenwahl.png' });
  await dlg.getByRole('button', { name: /Skatrunde/ }).click();
  await dlg.locator('.cal-einl').screenshot({ path: 'bilder/3-gruppe.png' });
  await dlg.getByRole('checkbox', { name: /Ben/ }).uncheck();
  await dlg.getByRole('button', { name: /Alle Kontakte/ }).click();
  await dlg.locator('.cal-einl').screenshot({ path: 'bilder/4-alle.png' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await dlg.locator('.cal-einl').screenshot({ path: 'bilder/5-desktop.png' });
});
