/**
 * „Bis zum Beginn passen N Erinnerungen“ gegen die gemeinsamen Testfälle.
 *
 * Dieselbe Datei liest `apps/api/tests/erinnern.rs` und lässt den echten
 * Dienst zu den Fälligkeitszeitpunkten laufen: Oberfläche und Server müssen für
 * jeden Fall dieselbe Zahl ergeben.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { erinnernSchema } from './schemas/calendar.js';
import { LIMITS } from './constants.js';
import { erinnerungenBisBeginn } from './util/erinnern.js';
import { messagePreview } from './util/format.js';

interface Fall {
  name: string;
  ab: string;
  beginn: string;
  ganztaegig: boolean;
  nachStunden: number;
  anzahl: number | null;
  erwartet: number;
}

const hier = dirname(fileURLToPath(import.meta.url));
const faelle: Fall[] = JSON.parse(
  readFileSync(resolve(hier, 'testdaten/erinnern.json'), 'utf8'),
).faelle;

describe('erinnerungenBisBeginn', () => {
  it('hat Testfälle', () => {
    expect(faelle.length).toBeGreaterThan(10);
  });
  for (const fall of faelle) {
    it(fall.name, () => {
      expect(erinnerungenBisBeginn(fall)).toBe(fall.erwartet);
    });
  }
  it('rechnet mit Unsinn nicht ins Unendliche', () => {
    const basis = { ab: '2030-01-01T00:00:00Z', beginn: '2031-01-01T00:00:00Z', ganztaegig: false };
    expect(erinnerungenBisBeginn({ ...basis, nachStunden: 0, anzahl: null })).toBe(0);
    expect(erinnerungenBisBeginn({ ...basis, nachStunden: NaN, anzahl: null })).toBe(0);
    expect(erinnerungenBisBeginn({ ...basis, nachStunden: 12, anzahl: 99 })).toBe(10);
    expect(
      erinnerungenBisBeginn({
        ab: 'kaputt',
        beginn: basis.beginn,
        ganztaegig: false,
        nachStunden: 12,
        anzahl: 3,
      }),
    ).toBe(0);
  });
});

describe('erinnernSchema', () => {
  it('nimmt die Grenzen an und lehnt darüber hinaus ab', () => {
    const ok = (nachStunden: number, anzahl: number | null) =>
      erinnernSchema.safeParse({ nachStunden, anzahl }).success;
    expect(ok(LIMITS.erinnernNachStdMin, 1)).toBe(true);
    expect(ok(LIMITS.erinnernNachStdMax, null)).toBe(true);
    expect(ok(LIMITS.erinnernNachStdMin - 1, 1)).toBe(false);
    expect(ok(LIMITS.erinnernNachStdMax + 1, 1)).toBe(false);
    expect(ok(24, 0)).toBe(false);
    expect(ok(24, LIMITS.erinnernAnzahlMax + 1)).toBe(false);
    expect(ok(24.5, 3)).toBe(false);
  });
});

describe('Vorschau einer Erinnerung', () => {
  it('heisst „Erinnerung“, nicht „Termin“', () => {
    const karte = { type: 'event' as const, metadata: { eventId: 'x', erinnerung: { nummer: 1 } } };
    expect(messagePreview(karte)).toBe('🔔 Erinnerung');
    expect(messagePreview({ type: 'event', metadata: { eventId: 'x' } })).toBe('📅 Termin');
  });
});
