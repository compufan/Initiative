import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Der Verlauf vor dem Beitritt: beantragen, zustimmen, mitlesen.
 *
 * Bis hierher gab es die Regel nur in der Schnittstelle – in der App fehlten
 * beide Hälften: der Knopf „Älteren Verlauf beantragen" und das Band „X möchte
 * mitlesen". Wer nach einem Beitritt einen abgeschnittenen Verlauf sah, bekam
 * keine Erklärung und keinen Weg.
 *
 * Der Test geht den Weg zu dritt, weil erst dann zu sehen ist, worauf es
 * ankommt: Zustimmen müssen ALLE. Nach der ersten Stimme darf sich nichts
 * öffnen.
 */

function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

async function signUp(browser: Browser, user: ReturnType<typeof credentials>): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(user.username);
  await page.getByLabel('Anzeigename').fill(user.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return page;
}

test('der Verlauf vor dem Beitritt wird beantragt und einstimmig freigegeben', async ({
  browser,
}) => {
  const anna = credentials('vanna');
  const bodo = credentials('vbodo');
  const cleo = credentials('vcleo');

  const annaPage = await signUp(browser, anna);
  const bodoPage = await signUp(browser, bodo);
  const cleoPage = await signUp(browser, cleo);

  // Anna und Bodo gründen eine Gruppe und reden.
  await annaPage.getByRole('button', { name: 'Neuer Chat' }).click();
  await annaPage.getByRole('tab', { name: /Gruppe/ }).click();
  await annaPage.getByLabel('Gruppenname').fill('Altbestand');
  await annaPage.getByPlaceholder('Mitglieder suchen').fill(bodo.username);
  await annaPage.getByText(bodo.displayName).first().click();
  await annaPage.getByRole('button', { name: /Gruppe erstellen|Erstellen/ }).click();
  await expect(annaPage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  const geheim = `Nur fuer uns, ${Date.now()}`;
  await annaPage.getByPlaceholder('Nachricht schreiben').fill(geheim);
  await annaPage.getByRole('button', { name: 'Senden' }).click();
  await expect(annaPage.getByText(geheim)).toBeVisible();

  /*
   * Anna selbst hat ebenfalls eine Grenze – die bekommt jeder, auch der
   * Gründer. Hinter ihrer liegt aber nichts, und deshalb darf ihr kein Knopf
   * angeboten werden. Genau diese Verwechslung – gesetztes Feld statt Inhalt –
   * war der erste Fehler in dieser Anzeige.
   */
  await expect(
    annaPage.getByRole('button', { name: 'Älteren Verlauf beantragen' }),
  ).toHaveCount(0);

  // Cleo kommt dazu.
  await annaPage
    .getByRole('button', { name: /Chat-Info|Info/ })
    .first()
    .click();
  await annaPage.getByRole('button', { name: /Mitglieder hinzufügen/ }).click();
  await annaPage.getByPlaceholder(/suchen/i).last().fill(cleo.username);
  await annaPage.getByText(cleo.displayName).first().click();
  await annaPage.getByRole('button', { name: /hinzufügen$|Hinzufügen/ }).last().click();
  // Das Blatt liegt sonst über dem Band und fängt den Klick ab.
  await annaPage.keyboard.press('Escape');
  await expect(annaPage.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });

  await expect(cleoPage.getByText('Altbestand').first()).toBeVisible({ timeout: 20_000 });
  await cleoPage.getByText('Altbestand').first().click();
  await expect(cleoPage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  // Was vorher war, sieht sie nicht – und sie erfährt auch, warum.
  await expect(cleoPage.getByText(geheim)).toHaveCount(0);
  const beantragen = cleoPage.getByRole('button', { name: 'Älteren Verlauf beantragen' });
  await expect(beantragen).toBeVisible({ timeout: 15_000 });

  await beantragen.click();
  await expect(cleoPage.getByRole('button', { name: 'Antrag zurückziehen' })).toBeVisible({
    timeout: 15_000,
  });

  // Anna und Bodo bekommen das Band – ohne neu zu laden.
  const annaBand = annaPage.getByRole('group', { name: `Antrag von ${cleo.displayName}` });
  await expect(annaBand).toBeVisible({ timeout: 20_000 });
  await annaBand.getByRole('button', { name: 'Zustimmen' }).click();

  /*
   * Der Kern der Regel: Eine Stimme genügt nicht. Nach Annas Ja muss der
   * Verlauf für Cleo weiterhin zu sein.
   */
  await expect(annaBand.getByText('Du hast zugestimmt')).toBeVisible({ timeout: 15_000 });
  await expect(cleoPage.getByText(geheim)).toHaveCount(0);

  await bodoPage.getByText('Altbestand').first().click();
  const bodoBand = bodoPage.getByRole('group', { name: `Antrag von ${cleo.displayName}` });
  await expect(bodoBand).toBeVisible({ timeout: 20_000 });
  await bodoBand.getByRole('button', { name: 'Zustimmen' }).click();

  // Jetzt sind alle dafür – und der Verlauf steht bei Cleo im Chat, ohne Reload.
  await expect(cleoPage.getByText(geheim)).toBeVisible({ timeout: 20_000 });
  await expect(
    cleoPage.getByRole('button', { name: 'Älteren Verlauf beantragen' }),
  ).toHaveCount(0);
  // Und das Band ist bei allen fort.
  await expect(annaBand).toHaveCount(0);

  await annaPage.context().close();
  await bodoPage.context().close();
  await cleoPage.context().close();
});

test('ein Nein schliesst den Verlauf – und hält', async ({ browser }) => {
  const anna = credentials('nanna');
  const bodo = credentials('nbodo');
  const cleo = credentials('ncleo');

  const annaPage = await signUp(browser, anna);
  const bodoPage = await signUp(browser, bodo);
  const cleoPage = await signUp(browser, cleo);

  await annaPage.getByRole('button', { name: 'Neuer Chat' }).click();
  await annaPage.getByRole('tab', { name: /Gruppe/ }).click();
  await annaPage.getByLabel('Gruppenname').fill('Verschlossen');
  await annaPage.getByPlaceholder('Mitglieder suchen').fill(bodo.username);
  await annaPage.getByText(bodo.displayName).first().click();
  await annaPage.getByRole('button', { name: /Gruppe erstellen|Erstellen/ }).click();
  await expect(annaPage.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  const geheim = `Bleibt zu, ${Date.now()}`;
  await annaPage.getByPlaceholder('Nachricht schreiben').fill(geheim);
  await annaPage.getByRole('button', { name: 'Senden' }).click();
  await expect(annaPage.getByText(geheim)).toBeVisible();

  await annaPage
    .getByRole('button', { name: /Chat-Info|Info/ })
    .first()
    .click();
  await annaPage.getByRole('button', { name: /Mitglieder hinzufügen/ }).click();
  await annaPage.getByPlaceholder(/suchen/i).last().fill(cleo.username);
  await annaPage.getByText(cleo.displayName).first().click();
  await annaPage.getByRole('button', { name: /hinzufügen$|Hinzufügen/ }).last().click();
  await annaPage.keyboard.press('Escape');

  await expect(cleoPage.getByText('Verschlossen').first()).toBeVisible({ timeout: 20_000 });
  await cleoPage.getByText('Verschlossen').first().click();
  await cleoPage.getByRole('button', { name: 'Älteren Verlauf beantragen' }).click();

  // Bodo ist dagegen – das entscheidet sofort, auch ohne Annas Stimme.
  await bodoPage.getByText('Verschlossen').first().click();
  const bodoBand = bodoPage.getByRole('group', { name: `Antrag von ${cleo.displayName}` });
  await expect(bodoBand).toBeVisible({ timeout: 20_000 });
  await bodoBand.getByRole('button', { name: 'Ablehnen' }).click();

  await expect(bodoBand).toHaveCount(0, { timeout: 15_000 });
  await expect(cleoPage.getByText(geheim)).toHaveCount(0);

  /*
   * Und ein Nein hält: Ohne Sperre wäre der Knopf ein Fingertipp, und jeder
   * neue Antrag legte allen anderen wieder ein Band über den Chat.
   */
  await expect(cleoPage.getByRole('button', { name: 'Antrag zurückziehen' })).toHaveCount(0, {
    timeout: 15_000,
  });
  await cleoPage.getByRole('button', { name: 'Älteren Verlauf beantragen' }).click();
  await expect(cleoPage.getByText(/erneut fragen/)).toBeVisible({ timeout: 15_000 });
  await expect(cleoPage.getByRole('button', { name: 'Antrag zurückziehen' })).toHaveCount(0);

  await annaPage.context().close();
  await bodoPage.context().close();
  await cleoPage.context().close();
});
