/**
 * Die Zustellungs-Planung gegen die gemeinsamen Testfälle.
 *
 * Dieselbe Datei liest der Rust-Test `apps/api/tests/einladen_plan.rs`: Die
 * Vorschau im Editor und der Server müssen für jeden Fall dasselbe ergeben.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { zustellungPlanen } from './util/zustellung.js';

interface Fall {
  name: string;
  ersteller: string;
  personen: string[];
  wunsch: { senden: boolean; einzelchats: boolean; gruppen: string[] };
  mitglieder: Record<string, string[]>;
  erwartet: {
    gruppen: string[];
    ausgelassen: { chat: string; fehlend: string[] }[];
    einzel: string[];
  };
}

const hier = dirname(fileURLToPath(import.meta.url));
const datei = JSON.parse(readFileSync(resolve(hier, 'testdaten/zustellung.json'), 'utf8')) as {
  faelle: Fall[];
};

describe('Zustellung planen', () => {
  it('hat Fälle', () => {
    expect(datei.faelle.length).toBeGreaterThanOrEqual(10);
  });

  for (const fall of datei.faelle) {
    it(fall.name, () => {
      const plan = zustellungPlanen(fall.ersteller, fall.personen, fall.wunsch, fall.mitglieder);
      expect(plan).toEqual(fall.erwartet);
    });
  }
});
