import { expect, request, test, type APIRequestContext } from '@playwright/test';

const API = `${process.env.E2E_API_URL ?? 'http://localhost:8080'}/api/v1`;
const OUT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-sammlung';

async function reg(http: APIRequestContext, p: string) {
  const s = Math.random().toString(36).slice(2, 8);
  const a = await http.post(`${API}/auth/register`, { data: { username: `${p}${s}`, password: 'passwort123', displayName: `${p.toUpperCase()} ${s}` } });
  return a.json();
}
const h = (x: any) => ({ authorization: `Bearer ${x.accessToken}` });

test('aufnahme', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const anna = await reg(http, 'ana');
  const bodo = await reg(http, 'bod');
  const cleo = await reg(http, 'cle');
  const dora = await reg(http, 'dor');
  const mk = async (who: any, name: string, parentId?: string) =>
    (await http.post(`${API}/collections`, { headers: h(who), data: { name, ...(parentId ? { parentId } : {}) } })).json();
  const familie = await mk(anna, 'Familie');
  await http.post(`${API}/collections/${familie.id}/grants`, { headers: h(anna), data: { userId: cleo.user.id, level: 'view' } });
  await mk(anna, 'Urlaube', familie.id);
  const bodos = await mk(bodo, 'Bodos');
  await http.post(`${API}/collections/${bodos.id}/grants`, { headers: h(bodo), data: { userId: anna.user.id, level: 'view' } });
  const offen = await mk(bodo, 'Offen', bodos.id);
  await http.post(`${API}/collections/${offen.id}/grants`, { headers: h(bodo), data: { userId: anna.user.id, level: 'edit' } });
  let p: string | undefined;
  for (let i = 1; i <= 8; i++) { const c = await mk(anna, `Tiefe ${i}`, p); p = c.id; }
  const beginn = new Date(); beginn.setDate(beginn.getDate() + 10);
  const t = await (await http.post(`${API}/calendar/events`, { headers: h(anna), data: { title: 'Hüttenwochenende am Schwarzsee mit allen', startsAt: beginn.toISOString(), endsAt: new Date(beginn.getTime() + 3600000).toISOString(), attendeeIds: [bodo.user.id, cleo.user.id, dora.user.id] } })).json();
  await http.patch(`${API}/calendar/events/${t.id}/attendees/${dora.user.id}`, { headers: h(dora), data: {} }).catch(() => {});

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(baseURL!);
  await page.evaluate((w) => localStorage.setItem('initiative.tokens', JSON.stringify(w)), { accessToken: anna.accessToken, refreshToken: anna.refreshToken, expiresAt: Date.now() + 3600000 });
  await page.goto(`${baseURL}/kalender/termin/${t.id}`);
  await expect(page.getByRole('heading', { name: 'Sammlung', exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('heading', { name: 'Sammlung', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/s1-abschnitt.png` });
  await page.getByRole('button', { name: /Neue Sammlung anlegen/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Neue Sammlung' });
  await expect(blatt).toBeVisible();
  await page.screenshot({ path: `${OUT}/s2-blatt-oben.png` });
  await blatt.getByRole('radio', { name: 'Familie', exact: true }).check();
  await page.waitForTimeout(800);
  await blatt.getByRole('radio', { name: 'Familie', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/s3-blatt-familie.png` });
  await blatt.getByText('Wer bekommt Zugriff?').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/s4-blatt-zugriff.png` });
  await blatt.getByRole('radio', { name: /^Tiefe 8/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/s5-blatt-tief.png` });
  await page.mouse.move(200, 600);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/s6-blatt-unten.png` });
  await blatt.getByRole('button', { name: 'Anlegen und verknüpfen' }).click();
  await expect(page.getByRole('link', { name: /Hüttenwochenende/ })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.getByRole('heading', { name: 'Sammlung', exact: true }).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 200);
  await page.screenshot({ path: `${OUT}/s7-verknuepft.png` });
});
