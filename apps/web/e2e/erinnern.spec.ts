import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Page } from '@playwright/test';
import { API, als, expect, test, type Welt } from './einladenWelt.js';

/**
 * Erinnern an ausstehende Antworten – mit mehreren Nutzern.
 *
 * Der Dienst wird nach Stunden fällig; ein Test kann nicht zwei Tage warten.
 * `erinnern_einmal` (nur Entwicklung und Tests, nicht im Abbild) rechnet einen
 * Durchgang mit der Uhr der Datenbank plus N Stunden – dieselbe Datenbank, derselbe
 * Weg wie der laufende Dienst.
 */

const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../api/target/debug/erinnern_einmal',
);
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:initiative@127.0.0.1:5432/initiative';

function durchgang(plusStunden: number): { beansprucht: number; zugestellt: number } {
  const aus = execFileSync(BIN, ['--plus-stunden', String(plusStunden)], {
    env: { ...process.env, DATABASE_URL: DB },
    encoding: 'utf8',
  });
  const zeile = aus.trim().split('\n').pop() ?? '{}';
  return JSON.parse(zeile);
}

const blatt = (seite: Page) => seite.getByRole('dialog');

async function erinnerungsKarten(
  welt: Welt,
  sitzung: Parameters<Welt['chatsVon']>[0],
  chatId: string,
  termin: string,
) {
  const nachrichten = await welt.nachrichten(sitzung, chatId);
  return nachrichten.filter(
    (n) =>
      n.type === 'event' &&
      !n.deletedAt &&
      n.metadata.eventId === termin &&
      (n.metadata as { erinnerung?: unknown }).erinnerung,
  );
}

test.describe('Erinnern an ausstehende Antworten', () => {
  test('im Terminblatt einstellen, Fehler sperren das Speichern, der Termin trägt die Einstellung', async ({
    welt,
  }) => {
    const seiteA = await welt.seite(welt.a);
    await seiteA.goto(`${welt.wurzel}/kalender`);
    await seiteA.getByRole('button', { name: /Neuer Termin/ }).click();
    await expect(blatt(seiteA)).toBeVisible();
    await seiteA.locator('#cal-title').fill('Grillen am See');

    const schalter = blatt(seiteA).getByRole('switch', { name: 'Ausstehende erinnern' });
    // Ohne Eingeladene gibt es nichts, woran erinnert würde.
    await expect(schalter).toBeDisabled();
    await expect(blatt(seiteA).getByText('Wähle zuerst Personen aus.')).toBeVisible();

    await expect(
      blatt(seiteA).getByRole('checkbox', { name: new RegExp(welt.b.user.displayName) }),
    ).toBeVisible({ timeout: 15_000 });
    await blatt(seiteA)
      .getByRole('checkbox', { name: new RegExp(welt.b.user.displayName) })
      .check();

    await expect(schalter).toBeEnabled();
    // Die Schalter sind unsichtbar (die Spur ist das Bild): Man tippt die Zeile an.
    await blatt(seiteA).locator('label.cal-switch', { hasText: 'Ausstehende erinnern' }).click();
    await expect(schalter).toBeChecked();
    // Vorgabe: nach 2 Tagen, dreimal – und die Zusammenfassung sagt es.
    await expect(blatt(seiteA).getByRole('radio', { name: '2 Tage' })).toBeChecked();
    await expect(blatt(seiteA).getByRole('radio', { name: 'Dreimal' })).toBeChecked();
    await expect(
      blatt(seiteA).getByText(/Wer nach 2 Tagen noch nicht geantwortet hat/),
    ).toBeVisible();

    // Eigene Dauer: zu kurz → Fehler am Feld, Speichern gesperrt.
    await blatt(seiteA).getByRole('radio', { name: 'Eigene Dauer' }).check({ force: true });
    const dauer = blatt(seiteA).getByRole('spinbutton', { name: 'Eigene Dauer in Stunden' });
    await dauer.fill('5');
    await expect(blatt(seiteA).getByText('Mindestens 12 Stunden.')).toBeVisible();
    await expect(blatt(seiteA).getByRole('button', { name: 'Termin erstellen' })).toBeDisabled();
    await dauer.fill('800');
    await expect(blatt(seiteA).getByText(/Höchstens 720 Stunden/)).toBeVisible();

    // Zurück zu einer Vorgabe: Fehler weg, Speichern frei.
    await blatt(seiteA).getByRole('radio', { name: '1 Tag' }).check({ force: true });
    await blatt(seiteA).getByRole('radio', { name: 'Zweimal' }).check({ force: true });
    await expect(blatt(seiteA).getByText(/Mindestens 12|Höchstens 720/)).toHaveCount(0);
    await blatt(seiteA).getByRole('button', { name: 'Termin erstellen' }).click();
    await expect(blatt(seiteA)).toBeHidden({ timeout: 15_000 });

    const id = await welt.terminId(welt.a, 'Grillen am See');
    const termin = await (
      await welt.http.get(`${API}/calendar/events/${id}`, { headers: als(welt.a) })
    ).json();
    expect(termin.erinnern).toEqual({ nachStunden: 24, anzahl: 2 });

    // Die Terminseite sagt es – und der Ersteller sieht den Stand.
    await seiteA.goto(`${welt.wurzel}/kalender/termin/${id}`);
    await expect(
      seiteA.getByText('Erinnerungen an Ausstehende: nach 1 Tag, bis zu 2-mal'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(seiteA.getByRole('region', { name: 'Erinnerungen' })).toContainText(
      'noch keine gesendet',
    );
  });

  test('der Dienst erinnert nur Ausstehende, nur im Einzelchat, und hört mit der Antwort auf', async ({
    welt,
  }) => {
    const termin = await welt.terminAnlegen(welt.a, {
      titel: 'Skatabend',
      personen: [welt.b, welt.c],
      gruppen: [welt.gruppe.id],
      zusatz: { erinnern: { nachStunden: 24, anzahl: 2 } },
    });
    // C sagt zu, B bleibt offen.
    await welt.zusagen(welt.c, termin, 'yes');

    // Noch nicht fällig.
    expect(durchgang(2).beansprucht).toBe(0);

    // Nach einem Tag und einer Stunde: genau eine Erinnerung, an B.
    expect(durchgang(25).beansprucht).toBe(1);

    const ab = await welt.einzelchat(welt.a, welt.b);
    const ac = await welt.einzelchat(welt.a, welt.c);
    expect(ab && ac).toBeTruthy();
    const anB = await erinnerungsKarten(welt, welt.b, ab!.id, termin.id);
    expect(anB).toHaveLength(1);
    expect((anB[0].metadata as { erinnerung: { nummer: number } }).erinnerung.nummer).toBe(1);
    expect(await erinnerungsKarten(welt, welt.c, ac!.id, termin.id)).toHaveLength(0);
    expect(await erinnerungsKarten(welt, welt.a, welt.gruppe.id, termin.id)).toHaveLength(0);

    // Zweimal derselbe Durchgang: nichts doppelt.
    expect(durchgang(25).beansprucht).toBe(0);

    // B sieht die Karte, mit Kopfzeile und dem, was fehlt – und antwortet darin.
    const seiteB = await welt.seite(welt.b);
    await seiteB.goto(`${welt.wurzel}/chats/${ab!.id}`);
    const karte = seiteB.locator('.cal-bubble-erinnerung');
    await expect(karte).toContainText('Automatische Erinnerung', { timeout: 15_000 });
    await expect(karte).toContainText('Du hast noch nicht auf „Skatabend“ geantwortet.');
    await seiteB
      .getByRole('button', { name: /Zusagen|Ja/i })
      .last()
      .click();
    await expect(karte).toContainText('Deine Antwort: Zugesagt.', { timeout: 15_000 });

    // Nach der Antwort kommt keine zweite mehr.
    expect(durchgang(50).beansprucht).toBe(0);
    expect(await erinnerungsKarten(welt, welt.b, ab!.id, termin.id)).toHaveLength(1);
  });

  test('ein abgesagter Termin und ein ausgeladener Gast bekommen keine Erinnerung', async ({
    welt,
  }) => {
    const abgesagt = await welt.terminAnlegen(welt.a, {
      titel: 'Fällt aus',
      personen: [welt.b],
      zusatz: { erinnern: { nachStunden: 12, anzahl: 3 } },
    });
    const weg = await welt.terminAnlegen(welt.a, {
      titel: 'Ohne Dich',
      personen: [welt.c],
      zusatz: { erinnern: { nachStunden: 12, anzahl: 3 } },
    });
    const absage = await welt.http.patch(`${API}/calendar/events/${abgesagt.id}`, {
      headers: als(welt.a),
      data: { status: 'cancelled' },
    });
    expect(absage.ok()).toBeTruthy();
    await welt.ausladen(welt.a, weg, welt.c);

    durchgang(13);
    const ab = await welt.einzelchat(welt.a, welt.b);
    const ac = await welt.einzelchat(welt.a, welt.c);
    expect(await erinnerungsKarten(welt, welt.b, ab!.id, abgesagt.id)).toHaveLength(0);
    expect(await erinnerungsKarten(welt, welt.c, ac!.id, weg.id)).toHaveLength(0);
  });
});
