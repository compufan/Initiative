import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS, zustellungPlanen, type ConversationDto } from '@initiative/shared';
import {
  LEERE_AUSWAHL,
  aenderungsVorschau,
  aendernBody,
  alleWaehlen,
  anlegenBody,
  bestehendeKarteHinweis,
  einzelchatMit,
  filtern,
  gruppeEntfernen,
  gruppeWaehlen,
  gruppenAus,
  gruppenStatus,
  kontakteAus,
  niemand,
  normalisiert,
  personUmschalten,
  planen,
  postenUmschalten,
  speichernText,
  terminOhneZustellung,
  unterschied,
  vorbelegung,
  vorgeschlageneGruppen,
  vorschau,
  zaehlerText,
  zeitOrtGeaendert,
  zeitOrtHinweis,
  type Auswahl,
  type Gruppe,
  type Kontakt,
} from './einladung.js';

/**
 * Die Regeln hinter dem Feld „Eingeladen“.
 *
 * Die schwersten Fehler, die hier festgehalten werden: „Alle“ darf keinen
 * Gruppenchat wählen (sonst postet „alle einladen“ in jeden Gruppenchat, in dem
 * zufällig alle dabei sind), ein Gruppenchat bekommt nur dann eine Karte, wenn
 * wirklich alle Mitglieder eingeladen sind, und wer die Einladungen nicht
 * anfasst, darf beim Speichern nichts an sie schicken.
 */

const ICH = 'ich';

const person = (id: string, name: string, username = name.toLowerCase().replace(/\W/g, '')) => ({
  id,
  displayName: name,
  username,
  avatarUrl: null,
  bio: null,
  accent: '#000',
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00Z',
});

function chat(
  id: string,
  art: 'direct' | 'group',
  mitglieder: [string, string][],
  optionen: { titel?: string; archiviert?: boolean } = {},
): ConversationDto {
  return {
    id,
    type: art,
    title: optionen.titel ?? null,
    archived: optionen.archiviert ?? false,
    members: mitglieder.map(([userId, name]) => ({
      userId,
      nickname: null,
      user: person(userId, name),
    })),
  } as unknown as ConversationDto;
}

const anna: [string, string] = ['anna', 'Anna Adler'];
const ben: [string, string] = ['ben', 'Ben Braun'];
const clara: [string, string] = ['clara', 'Clara Weiss'];
const dora: [string, string] = ['dora', 'Dora Dietz'];
const emil: [string, string] = ['emil', 'Émil Ärger'];
const ich: [string, string] = [ICH, 'Ich'];

const kontakt = (id: string, name: string): Kontakt => ({
  id,
  displayName: name,
  username: id,
  avatarUrl: null,
});

const gruppe = (id: string, titel: string, mitglieder: string[]): Gruppe => ({
  id,
  titel,
  mitglieder,
  anzahl: mitglieder.length + 1,
});

const auswahl = (
  personen: string[],
  gruppen: string[] = [],
  postenAus: string[] = [],
): Auswahl => ({
  personen,
  gruppen,
  postenAus,
});

describe('kontakteAus', () => {
  it('nimmt Personen aus allen Chats, ohne mich und ohne Doppelte', () => {
    const chats = [
      chat('g1', 'group', [ich, anna, ben], { titel: 'Skat' }),
      chat('d1', 'direct', [ich, anna]),
      chat('g2', 'group', [ich, clara, ben], { titel: 'Hütte' }),
    ];
    const ids = kontakteAus(chats, ICH).map((k) => k.id);
    expect(ids.sort()).toEqual(['anna', 'ben', 'clara']);
  });

  it('zählt nur nicht archivierte Chats', () => {
    const chats = [
      chat('g1', 'group', [ich, anna], { titel: 'Skat' }),
      chat('g2', 'group', [ich, ben], { titel: 'Alt', archiviert: true }),
    ];
    expect(kontakteAus(chats, ICH).map((k) => k.id)).toEqual(['anna']);
  });

  it('zählt Einzelchats', () => {
    expect(kontakteAus([chat('d1', 'direct', [ich, dora])], ICH).map((k) => k.id)).toEqual([
      'dora',
    ]);
  });

  it('sortiert deutsch und ohne Gross-/Kleinschreibung, Umlaute nach ihrem Grundbuchstaben', () => {
    const chats = [chat('g', 'group', [ich, ben, emil, anna, dora, clara], { titel: 'X' })];
    // „Émil Ärger“ steht bei E, nicht hinter Z.
    expect(kontakteAus(chats, ICH).map((k) => k.displayName)).toEqual([
      'Anna Adler',
      'Ben Braun',
      'Clara Weiss',
      'Dora Dietz',
      'Émil Ärger',
    ]);
  });

  it('nennt nur, was die Suche ohnehin preisgibt', () => {
    const [k] = kontakteAus([chat('d', 'direct', [ich, anna])], ICH);
    expect(Object.keys(k!).sort()).toEqual(['avatarUrl', 'displayName', 'id', 'username']);
  });

  it('ist ohne Chats leer', () => {
    expect(kontakteAus([], ICH)).toEqual([]);
  });
});

describe('einzelchatMit', () => {
  it('kennt Einzelchats, auch archivierte', () => {
    const chats = [
      chat('d1', 'direct', [ich, anna]),
      chat('d2', 'direct', [ich, ben], { archiviert: true }),
      chat('g', 'group', [ich, clara, dora], { titel: 'Gruppe' }),
    ];
    expect([...einzelchatMit(chats, ICH)].sort()).toEqual(['anna', 'ben']);
  });

  it('ein Einzelchat, den das Gegenüber verlassen hat, zählt nicht', () => {
    expect(einzelchatMit([chat('d', 'direct', [ich])], ICH).size).toBe(0);
  });
});

describe('gruppenAus', () => {
  it('nimmt nur nicht archivierte Gruppenchats mit Mitgliedern ausser mir', () => {
    const chats = [
      chat('g1', 'group', [ich, anna, ben], { titel: 'Skat' }),
      chat('g2', 'group', [ich], { titel: 'Allein' }),
      chat('g3', 'group', [ich, clara], { titel: 'Alt', archiviert: true }),
      chat('d1', 'direct', [ich, dora]),
    ];
    const gruppen = gruppenAus(chats, ICH);
    expect(gruppen).toEqual([{ id: 'g1', titel: 'Skat', mitglieder: ['anna', 'ben'], anzahl: 3 }]);
  });

  it('sortiert nach Titel', () => {
    const chats = [
      chat('g1', 'group', [ich, anna], { titel: 'Zelten' }),
      chat('g2', 'group', [ich, ben], { titel: 'Angeln' }),
    ];
    expect(gruppenAus(chats, ICH).map((g) => g.titel)).toEqual(['Angeln', 'Zelten']);
  });
});

describe('filtern', () => {
  const liste = [
    kontakt('anna', 'Anna Adler'),
    kontakt('ben', 'Ben Braun'),
    kontakt('mueller', 'Jörg Müller'),
  ];

  it('ohne Eingabe bleibt die Liste, wie sie ist', () => {
    expect(filtern(liste, '')).toBe(liste);
    expect(filtern(liste, '   ')).toBe(liste);
  });

  it('findet einen Teilstring, ohne Gross-/Kleinschreibung', () => {
    expect(filtern(liste, 'BRA').map((k) => k.id)).toEqual(['ben']);
  });

  it('findet ohne Akzente: „muller“ und „jorg“ finden „Jörg Müller“', () => {
    expect(filtern(liste, 'muller').map((k) => k.id)).toEqual(['mueller']);
    expect(filtern(liste, 'jorg').map((k) => k.id)).toEqual(['mueller']);
  });

  it('findet über den Benutzernamen, auch mit @', () => {
    expect(filtern(liste, 'mueller').map((k) => k.id)).toEqual(['mueller']);
    expect(filtern(liste, '@ben').map((k) => k.id)).toEqual(['ben']);
  });

  it('jedes Wort muss passen, in beliebiger Reihenfolge', () => {
    expect(filtern(liste, 'adler ann').map((k) => k.id)).toEqual(['anna']);
    expect(filtern(liste, 'anna braun')).toEqual([]);
  });

  it('behält die Reihenfolge', () => {
    expect(filtern(liste, 'r').map((k) => k.id)).toEqual(['anna', 'ben', 'mueller']);
  });

  it('normalisiert ß und Akzente', () => {
    expect(normalisiert('Straße Éclair')).toBe('strasse eclair');
  });
});

describe('alleWaehlen', () => {
  const kontakte = [kontakt('a', 'A'), kontakt('b', 'B'), kontakt('c', 'C')];

  it('wählt alle Kontakte – und keinen Gruppenchat', () => {
    const { auswahl: neu, abgeschnitten } = alleWaehlen(kontakte, LEERE_AUSWAHL);
    expect(neu.personen).toEqual(['a', 'b', 'c']);
    expect(neu.gruppen).toEqual([]);
    expect(abgeschnitten).toBe(false);
  });

  it('schon Gewählte bleiben, auch Nicht-Kontakte von der Suche', () => {
    const { auswahl: neu } = alleWaehlen(kontakte, auswahl(['fremd', 'b']));
    expect(neu.personen).toEqual(['fremd', 'b', 'a', 'c']);
  });

  it('bei mehr als der Obergrenze: abgeschnitten', () => {
    const viele = Array.from({ length: LIMITS.einladungenMax + 5 }, (_, i) =>
      kontakt(`u${i}`, `Person ${i}`),
    );
    const { auswahl: neu, abgeschnitten } = alleWaehlen(viele, LEERE_AUSWAHL);
    expect(abgeschnitten).toBe(true);
    expect(neu.personen).toHaveLength(LIMITS.einladungenMax);
  });

  it('genau an der Obergrenze ist nichts abgeschnitten', () => {
    const genau = Array.from({ length: LIMITS.einladungenMax }, (_, i) =>
      kontakt(`u${i}`, `Person ${i}`),
    );
    expect(alleWaehlen(genau, LEERE_AUSWAHL).abgeschnitten).toBe(false);
  });

  it('lässt bestehende Gruppen-Chips unberührt', () => {
    const { auswahl: neu } = alleWaehlen(kontakte, auswahl(['a'], ['g'], ['g']));
    expect(neu.gruppen).toEqual(['g']);
    expect(neu.postenAus).toEqual(['g']);
  });
});

describe('niemand und einzelne Personen', () => {
  it('„Niemand“ leert Personen und Gruppen', () => {
    expect(niemand()).toEqual({ personen: [], gruppen: [], postenAus: [] });
  });

  it('eine Person an- und abwählen', () => {
    const an = personUmschalten(LEERE_AUSWAHL, 'a');
    expect(an.personen).toEqual(['a']);
    expect(personUmschalten(an, 'a').personen).toEqual([]);
  });
});

describe('gruppeWaehlen und gruppenStatus', () => {
  const skat = gruppe('skat', 'Skat', ['anna', 'ben', 'clara']);
  const huette = gruppe('huette', 'Hütte', ['ben', 'dora']);

  it('wählt die Mitglieder ohne mich und legt den Chip an', () => {
    const { auswahl: neu, zuViele } = gruppeWaehlen(LEERE_AUSWAHL, skat);
    expect(zuViele).toBe(false);
    expect(neu.personen).toEqual(['anna', 'ben', 'clara']);
    expect(neu.gruppen).toEqual(['skat']);
  });

  it('der Chip zählt mich mit: „4 von 4“', () => {
    const { auswahl: neu } = gruppeWaehlen(LEERE_AUSWAHL, skat);
    expect(gruppenStatus(skat, neu.personen)).toEqual({
      eingeladen: 4,
      gesamt: 4,
      fehlen: [],
      vollstaendig: true,
    });
  });

  it('ein abgewähltes Mitglied macht den Chip unvollständig, die Wiederwahl stellt ihn her', () => {
    let { auswahl: neu } = gruppeWaehlen(LEERE_AUSWAHL, skat);
    neu = personUmschalten(neu, 'clara');
    const status = gruppenStatus(skat, neu.personen);
    expect(status.vollstaendig).toBe(false);
    expect(status.fehlen).toEqual(['clara']);
    expect(status.eingeladen).toBe(3);

    neu = personUmschalten(neu, 'clara');
    expect(gruppenStatus(skat, neu.personen).vollstaendig).toBe(true);
  });

  it('zwei Gruppen mit Überschneidung: jeder nur einmal', () => {
    let { auswahl: neu } = gruppeWaehlen(LEERE_AUSWAHL, skat);
    neu = gruppeWaehlen(neu, huette).auswahl;
    expect(neu.personen).toEqual(['anna', 'ben', 'clara', 'dora']);
    expect(neu.gruppen).toEqual(['skat', 'huette']);
  });

  it('erneutes Wählen entfernt nur den Chip, die Personen bleiben', () => {
    let { auswahl: neu } = gruppeWaehlen(LEERE_AUSWAHL, skat);
    neu = gruppeWaehlen(neu, skat).auswahl;
    expect(neu.gruppen).toEqual([]);
    expect(neu.personen).toEqual(['anna', 'ben', 'clara']);
  });

  it('entfernt mit dem Chip auch seinen abgeschalteten Schalter', () => {
    const neu = gruppeEntfernen(auswahl(['a'], ['g'], ['g']), 'g');
    expect(neu.postenAus).toEqual([]);
  });

  it('mehr als die Obergrenze: Wahl bleibt unverändert', () => {
    const gross = gruppe(
      'gross',
      'Gross',
      Array.from({ length: LIMITS.einladungenMax + 1 }, (_, i) => `u${i}`),
    );
    const vorher = auswahl(['x']);
    const ergebnis = gruppeWaehlen(vorher, gross);
    expect(ergebnis.zuViele).toBe(true);
    expect(ergebnis.auswahl).toBe(vorher);
  });

  it('mehr als zehn Gruppenchats lassen sich nicht wählen', () => {
    let a: Auswahl = LEERE_AUSWAHL;
    for (let i = 0; i < LIMITS.einladungGruppenMax; i += 1) {
      a = gruppeWaehlen(a, gruppe(`g${i}`, `G${i}`, [`u${i}`])).auswahl;
    }
    const elfte = gruppeWaehlen(a, gruppe('g11', 'G11', ['u11']));
    expect(elfte.zuViele).toBe(true);
    expect(elfte.auswahl).toBe(a);
  });

  it('der Schalter „dort posten“ springt auf seinen letzten Stand zurück', () => {
    let a = gruppeWaehlen(LEERE_AUSWAHL, skat).auswahl;
    a = postenUmschalten(a, 'skat');
    expect(a.postenAus).toEqual(['skat']);
    a = personUmschalten(a, 'clara');
    a = personUmschalten(a, 'clara');
    // Nach Abwahl und Wiederwahl steht der Schalter noch, wie man ihn gelassen hat.
    expect(a.postenAus).toEqual(['skat']);
  });
});

describe('„Alle“ postet in keinen Gruppenchat', () => {
  it('auch nicht, wenn zufällig alle Mitglieder einer Gruppe gewählt sind', () => {
    const skat = gruppe('skat', 'Skat', ['anna', 'ben']);
    const kontakte = [kontakt('anna', 'Anna'), kontakt('ben', 'Ben'), kontakt('clara', 'Clara')];
    const { auswahl: alle } = alleWaehlen(kontakte, LEERE_AUSWAHL);

    const plan = planen(ICH, alle, { senden: true, einzelchats: true }, [skat]);

    expect(plan.gruppen).toEqual([]);
    expect(plan.einzel).toEqual(['anna', 'ben', 'clara']);
  });

  it('bietet die Gruppe stattdessen als Vorschlag an', () => {
    const skat = gruppe('skat', 'Skat', ['anna', 'ben']);
    const huette = gruppe('huette', 'Hütte', ['anna', 'dora']);
    const alle = auswahl(['anna', 'ben', 'clara']);
    expect(vorgeschlageneGruppen([skat, huette], alle).map((g) => g.id)).toEqual(['skat']);
  });
});

describe('vorgeschlageneGruppen', () => {
  const gruppen = ['a', 'b', 'c', 'd', 'e'].map((x) => gruppe(x, x.toUpperCase(), ['p']));

  it('höchstens drei', () => {
    expect(vorgeschlageneGruppen(gruppen, auswahl(['p']))).toHaveLength(3);
  });

  it('nicht, was schon als Chip dasteht', () => {
    expect(vorgeschlageneGruppen(gruppen, auswahl(['p'], ['a'])).map((g) => g.id)).toEqual([
      'b',
      'c',
      'd',
    ]);
  });

  it('nicht, wenn jemand fehlt', () => {
    const halb = gruppe('x', 'X', ['p', 'q']);
    expect(vorgeschlageneGruppen([halb], auswahl(['p']))).toEqual([]);
  });
});

describe('zaehlerText', () => {
  it('Einzahl und Mehrzahl', () => {
    expect(zaehlerText(0, 3)).toBe('0 von 3 Personen');
    expect(zaehlerText(1, 1)).toBe('1 von 1 Person');
    expect(zaehlerText(5, 12)).toBe('5 von 12 Personen');
  });
});

describe('zustellungPlanen gegen die gemeinsamen Testfälle', () => {
  // Dieselbe Datei liest der Server in seinem Test: Vorschau und Zustellung
  // dürfen nicht auseinanderlaufen.
  const datei = fileURLToPath(
    new URL('../../../../../packages/shared/src/testdaten/zustellung.json', import.meta.url),
  );
  const { faelle } = JSON.parse(readFileSync(datei, 'utf8')) as {
    faelle: {
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
    }[];
  };

  it('die Datei ist da und hat Fälle', () => {
    expect(faelle.length).toBeGreaterThan(5);
  });

  it.each(faelle.map((fall) => [fall.name, fall] as const))('%s', (_name, fall) => {
    expect(zustellungPlanen(fall.ersteller, fall.personen, fall.wunsch, fall.mitglieder)).toEqual(
      fall.erwartet,
    );
  });
});

describe('planen', () => {
  const skat = gruppe('skat', 'Skat', ['anna', 'ben']);

  it('nimmt nur Chips, bei denen „dort posten“ an ist', () => {
    const an = planen(
      ICH,
      auswahl(['anna', 'ben'], ['skat']),
      { senden: true, einzelchats: true },
      [skat],
    );
    expect(an.gruppen).toEqual(['skat']);

    const aus = planen(
      ICH,
      auswahl(['anna', 'ben'], ['skat'], ['skat']),
      { senden: true, einzelchats: true },
      [skat],
    );
    expect(aus.gruppen).toEqual([]);
  });

  it('meldet Fehlende als ausgelassen, die Einzelkarten bleiben', () => {
    const plan = planen(ICH, auswahl(['anna'], ['skat']), { senden: true, einzelchats: true }, [
      skat,
    ]);
    expect(plan.gruppen).toEqual([]);
    expect(plan.ausgelassen).toEqual([{ chat: 'skat', fehlend: ['ben'] }]);
    expect(plan.einzel).toEqual(['anna']);
  });
});

describe('vorschau', () => {
  const skat = gruppe('skat', 'Skat', ['anna', 'ben']);
  const huette = gruppe('huette', 'Hütte', ['ben', 'dora']);
  const namen: Record<string, string> = { anna: 'Anna', ben: 'Ben', dora: 'Dora', clara: 'Clara' };
  const basis = {
    myId: ICH,
    gruppen: [skat, huette],
    einzelchatMit: new Set<string>(),
    name: (id: string) => namen[id] ?? id,
  };
  const an = { senden: true, einzelchats: true };

  it('nennt die Gruppe mit Karte und die Zahl der Einzelchats', () => {
    const zeilen = vorschau({ ...basis, auswahl: auswahl(['anna', 'ben'], ['skat']), eingabe: an });
    expect(zeilen).toContain('Gruppenchat „Skat“: Karte.');
    expect(zeilen.some((zeile) => zeile.startsWith('2 Einzelchats'))).toBe(true);
  });

  it('nennt, wer fehlt, und dass dort nichts gepostet wird', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['ben'], ['huette']),
      einzelchatMit: new Set(['ben']),
      eingabe: an,
    });
    expect(zeilen).toContain('Gruppenchat „Hütte“: keine Karte – Dora fehlt.');
    expect(zeilen).toContain('1 Einzelchat.');
  });

  it('eine abgewählte Gruppe: „keine Karte (abgewählt)“', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben'], ['skat'], ['skat']),
      eingabe: an,
    });
    expect(zeilen).toContain('Gruppenchat „Skat“: keine Karte (abgewählt).');
  });

  it('zählt die neuen Einzelchats aus dem, was im Speicher steht', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben', 'clara']),
      einzelchatMit: new Set(['anna']),
      eingabe: an,
    });
    expect(zeilen).toContain('3 Einzelchats, davon 2 neu angelegt.');
  });

  it('ein einziger neuer Einzelchat heisst „einer“', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben']),
      einzelchatMit: new Set(['anna']),
      eingabe: an,
    });
    expect(zeilen).toContain('2 Einzelchats, davon einer neu angelegt.');
  });

  it('bei ausgeschaltetem Senden: niemand bekommt eine Nachricht', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben'], ['skat']),
      eingabe: { senden: false, einzelchats: true },
    });
    expect(zeilen[0]).toMatch(/^Niemand bekommt eine Nachricht/);
    expect(zeilen.join(' ')).not.toMatch(/Gruppenchat/);
  });

  it('ohne Einladung steht der Termin nur im eigenen Kalender', () => {
    const zeilen = vorschau({ ...basis, auswahl: LEERE_AUSWAHL, eingabe: an });
    expect(zeilen).toEqual(['Niemand ist eingeladen – der Termin steht nur in deinem Kalender.']);
  });

  it('ohne Einzelchats und ohne Gruppenkarte bekommt niemand eine Karte', () => {
    const zeilen = vorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben']),
      eingabe: { senden: true, einzelchats: false },
    });
    expect(zeilen).toContain('Keine Karten in Einzelchats.');
    expect(zeilen.some((zeile) => zeile.startsWith('Niemand bekommt eine Karte'))).toBe(true);
  });

  it('sagt, dass die Teilnehmerliste für alle sichtbar ist – erst ab zwei Personen', () => {
    const viele = vorschau({ ...basis, auswahl: auswahl(['anna', 'ben']), eingabe: an });
    expect(viele.some((zeile) => zeile.startsWith('Alle Eingeladenen sehen'))).toBe(true);
    const eine = vorschau({ ...basis, auswahl: auswahl(['anna']), eingabe: an });
    expect(eine.some((zeile) => zeile.startsWith('Alle Eingeladenen sehen'))).toBe(false);
  });

  it('zählt Fehlende auf: drei ausgeschrieben, mehr als „und n weitere“', () => {
    const grosse = gruppe('gross', 'Gross', ['p1', 'p2', 'p3', 'p4', 'p5']);
    const zeilen = vorschau({
      ...basis,
      gruppen: [grosse],
      auswahl: auswahl([], ['gross']),
      eingabe: an,
    });
    // Ohne Eingeladene gibt es nichts zu senden.
    expect(zeilen).toEqual(['Niemand ist eingeladen – der Termin steht nur in deinem Kalender.']);

    const mit = vorschau({
      ...basis,
      gruppen: [grosse],
      auswahl: auswahl(['q'], ['gross']),
      eingabe: an,
      name: (id) => id.toUpperCase(),
    });
    expect(mit).toContain('Gruppenchat „Gross“: keine Karte – P1, P2, P3 und 2 weitere fehlen.');
  });
});

describe('unterschied', () => {
  it('neu und entfernt', () => {
    expect(unterschied(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ neu: ['d'], entfernt: ['a'] });
  });
});

describe('aenderungsVorschau', () => {
  const skat = gruppe('skat', 'Skat', ['anna', 'ben']);
  const basis = {
    myId: ICH,
    gruppen: [skat],
    eingabe: { senden: true, einzelchats: true },
    zugesagt: new Set<string>(),
    einzelchatMit: new Set<string>(),
    name: (id: string) => id.toUpperCase(),
  };

  it('ohne Änderung an den Einladungen keine Zeile', () => {
    expect(
      aenderungsVorschau({
        ...basis,
        auswahl: auswahl(['anna', 'ben'], ['skat']),
        vorher: ['anna', 'ben'],
        bestehendeGruppen: ['skat'],
      }),
    ).toEqual([]);
  });

  it('nennt Neue und Entfernte', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna', 'clara']),
      vorher: ['anna', 'ben'],
      zugesagt: new Set(['ben']),
      einzelchatMit: new Set(['clara']),
      bestehendeGruppen: null,
    });
    expect(zeilen).toEqual([
      'Neu eingeladen: 1 → Karte im Einzelchat und Benachrichtigung.',
      'Entfernt: 1 (BEN) → verliert den Zugang, die Karte im Einzelchat wird gelöscht. BEN hatte zugesagt.',
    ]);
  });

  it('nennt neu angelegte Einzelchats', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna', 'clara', 'dora']),
      vorher: ['anna'],
      bestehendeGruppen: null,
    });
    expect(zeilen[0]).toBe(
      'Neu eingeladen: 2 → Karte im Einzelchat und Benachrichtigung (2 Einzelchats werden neu angelegt).',
    );
  });

  it('nennt bei „Entfernt“ immer die Namen, nicht nur die der Zusagenden', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna']),
      vorher: ['anna', 'ben', 'clara', 'dora', 'emil'],
      bestehendeGruppen: null,
    });
    expect(zeilen).toEqual([
      'Entfernt: 4 (BEN, CLARA, DORA und 1 weitere) → verlieren den Zugang, die Karten im Einzelchat werden gelöscht.',
    ]);
  });

  it('ohne Karte im Einzelchat gibt es auch keine Benachrichtigung', () => {
    // Der Server benachrichtigt nur über eine Karte, die er zugestellt hat:
    // „Benachrichtigung, ohne Karte“ versprach etwas, das nicht geschieht.
    const zeilen = aenderungsVorschau({
      ...basis,
      eingabe: { senden: true, einzelchats: false },
      auswahl: auswahl(['anna', 'clara']),
      vorher: ['anna'],
      bestehendeGruppen: null,
    });
    expect(zeilen).toEqual([
      'Neu eingeladen: 1 → keine Karte, keine Benachrichtigung – nur im Kalender.',
    ]);
  });

  it('ohne Einzelkarte erreicht eine neue Gruppenkarte die Neuen darin', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      eingabe: { senden: true, einzelchats: false },
      // Ben ist neu und sitzt in Skat, Clara ist neu und nicht.
      auswahl: auswahl(['anna', 'ben', 'clara'], ['skat']),
      vorher: ['anna'],
      bestehendeGruppen: [],
    });
    expect(zeilen).toEqual([
      'Neu eingeladen: 2 → 1 über die Karte im Gruppenchat benachrichtigt, 1 ohne Karte und ohne Benachrichtigung – nur im Kalender.',
      'Gruppenchat „Skat“: Karte wird gepostet.',
    ]);

    const alleDrin = aenderungsVorschau({
      ...basis,
      eingabe: { senden: true, einzelchats: false },
      auswahl: auswahl(['anna', 'ben'], ['skat']),
      vorher: [],
      bestehendeGruppen: [],
    });
    expect(alleDrin[0]).toBe(
      'Neu eingeladen: 2 → Benachrichtigung über die Karte im Gruppenchat, ohne Karte im Einzelchat.',
    );
  });

  it('beim nachträglichen Einladen („nur Neue“) steht nichts über Entfernte da', () => {
    // Die Terminseite kennt nur die Neuen in der Wahl: Wer schon eingeladen
    // ist, wird nicht ausgeladen und gehört nicht in die Rechnung.
    expect(
      aenderungsVorschau({
        ...basis,
        auswahl: auswahl([]),
        vorher: [],
        bestehendeGruppen: null,
      }),
    ).toEqual([]);
    expect(
      aenderungsVorschau({
        ...basis,
        auswahl: auswahl(['clara']),
        vorher: [],
        bestehendeGruppen: null,
      }),
    ).toEqual([
      'Neu eingeladen: 1 → Karte im Einzelchat und Benachrichtigung (ein Einzelchat wird neu angelegt).',
    ]);
  });

  it('ohne Senden kommen die Neuen nur in den Kalender', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      eingabe: { senden: false, einzelchats: true },
      auswahl: auswahl(['anna', 'ben', 'clara']),
      vorher: ['anna', 'ben'],
      bestehendeGruppen: null,
    });
    expect(zeilen).toEqual(['Neu eingeladen: 1 – nur im Kalender, ohne Nachricht.']);
  });

  it('eine abgewählte bestehende Gruppenkarte wird gelöscht', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben'], ['skat'], ['skat']),
      vorher: ['anna', 'ben'],
      bestehendeGruppen: ['skat'],
    });
    expect(zeilen).toEqual(['Die Karte im Gruppenchat „Skat“ wird gelöscht.']);
  });

  it('eine neue Gruppe: Karte, oder keine Karte mit den Fehlenden', () => {
    const voll = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben'], ['skat']),
      vorher: ['anna', 'ben'],
      bestehendeGruppen: [],
    });
    expect(voll).toEqual(['Gruppenchat „Skat“: Karte wird gepostet.']);

    const luecke = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna'], ['skat']),
      vorher: ['anna'],
      bestehendeGruppen: [],
    });
    expect(luecke).toEqual(['Gruppenchat „Skat“: keine Karte – BEN fehlt.']);
  });

  it('solange die Karten nicht geladen sind, steht nichts über Gruppen da', () => {
    const zeilen = aenderungsVorschau({
      ...basis,
      auswahl: auswahl(['anna', 'ben'], ['skat'], ['skat']),
      vorher: ['anna', 'ben'],
      bestehendeGruppen: null,
    });
    expect(zeilen).toEqual([]);
  });

  it('eine bestehende Karte mit fehlenden Mitgliedern bleibt – der Hinweis sagt es', () => {
    expect(bestehendeKarteHinweis(['dora', 'emil'], (id) => id)).toBe(
      'Karte steht bereits – dora und emil sehen sie nicht als Termin.',
    );
    expect(bestehendeKarteHinweis(['dora'], (id) => id)).toBe(
      'Karte steht bereits – dora sieht sie nicht als Termin.',
    );
  });
});

describe('zeitOrtGeaendert', () => {
  const alt = {
    startsAt: '2026-10-04T16:00:00Z',
    endsAt: '2026-10-04T18:00:00Z',
    allDay: false,
    rrule: null,
    location: 'Park',
  };

  it('nichts geändert', () => {
    expect(zeitOrtGeaendert(alt, { ...alt })).toBeNull();
  });

  it('dieselbe Zeit in anderer Schreibweise ist keine Änderung', () => {
    expect(zeitOrtGeaendert(alt, { ...alt, startsAt: '2026-10-04T18:00:00+02:00' })).toBeNull();
  });

  it('Zeit, Ort, beides', () => {
    expect(zeitOrtGeaendert(alt, { ...alt, endsAt: '2026-10-04T19:00:00Z' })).toBe('zeit');
    expect(zeitOrtGeaendert(alt, { ...alt, location: 'See' })).toBe('ort');
    expect(zeitOrtGeaendert(alt, { ...alt, allDay: true, location: 'See' })).toBe('zeitUndOrt');
  });

  it('Leerzeichen am Ort zählen nicht', () => {
    expect(zeitOrtGeaendert(alt, { ...alt, location: ' Park ' })).toBeNull();
  });

  it('eine neue Wiederholung ist eine Zeitänderung', () => {
    expect(zeitOrtGeaendert(alt, { ...alt, rrule: 'FREQ=WEEKLY' })).toBe('zeit');
  });
});

describe('anlegenBody', () => {
  it('enthält zustellung und clientId, nie conversationId oder announce', () => {
    const body = anlegenBody(
      auswahl(['anna', 'ben'], ['skat'], ['huette']),
      { senden: true, einzelchats: false },
      'schluessel-1',
    );
    expect(body).toEqual({
      attendeeIds: ['anna', 'ben'],
      zustellung: { senden: true, einzelchats: false, gruppenChatIds: ['skat'] },
      clientId: 'schluessel-1',
    });
    expect(body).not.toHaveProperty('conversationId');
    expect(body).not.toHaveProperty('announce');
  });

  it('gibt abgeschaltete Gruppen nicht an den Server', () => {
    const body = anlegenBody(
      auswahl(['a'], ['g1', 'g2'], ['g1']),
      { senden: true, einzelchats: true },
      'k',
    );
    expect(body.zustellung.gruppenChatIds).toEqual(['g2']);
  });

  it('niemand gewählt heisst eine leere Liste – nicht „alle aus dem Chat“', () => {
    const body = anlegenBody(LEERE_AUSWAHL, { senden: true, einzelchats: true }, 'k');
    expect(body.attendeeIds).toEqual([]);
    expect(body.zustellung.gruppenChatIds).toEqual([]);
  });

  it('lässt mich selbst aus der Liste', () => {
    expect(
      anlegenBody(auswahl([ICH, 'a']), { senden: true, einzelchats: true }, 'k', ICH).attendeeIds,
    ).toEqual(['a']);
  });
});

describe('aendernBody', () => {
  const an = { senden: true, einzelchats: true };

  it('ohne Änderung an den Einladungen weder attendeeIds noch zustellung', () => {
    expect(
      aendernBody(auswahl(['anna', 'ben']), an, { teilnehmer: ['ben', 'anna'], gruppen: null }),
    ).toEqual({});
    expect(
      aendernBody(auswahl(['anna'], ['skat']), an, { teilnehmer: ['anna'], gruppen: ['skat'] }),
    ).toEqual({});
  });

  it('gruppenChatIds fehlt, solange die Zustellung nicht geladen ist', () => {
    const body = aendernBody(auswahl(['anna', 'ben'], ['skat']), an, {
      teilnehmer: ['anna'],
      gruppen: null,
    });
    expect(body.attendeeIds).toEqual(['anna', 'ben']);
    expect(body.zustellung).toEqual({ senden: true, einzelchats: true });
    expect(body.zustellung).not.toHaveProperty('gruppenChatIds');
  });

  it('schickt die Personen nur, wenn sie sich geändert haben', () => {
    const body = aendernBody(auswahl(['anna'], ['skat', 'huette']), an, {
      teilnehmer: ['anna'],
      gruppen: ['skat'],
    });
    expect(body).toEqual({
      zustellung: { senden: true, einzelchats: true, gruppenChatIds: ['skat', 'huette'] },
    });
    expect(body).not.toHaveProperty('attendeeIds');
  });

  it('eine abgewählte bestehende Gruppenkarte wird über die Liste abgewählt', () => {
    const body = aendernBody(auswahl(['anna'], ['skat'], ['skat']), an, {
      teilnehmer: ['anna'],
      gruppen: ['skat'],
    });
    expect(body.zustellung?.gruppenChatIds).toEqual([]);
  });

  it('Ausladen: die Liste ohne den Entfernten', () => {
    const body = aendernBody(auswahl(['anna']), an, { teilnehmer: ['anna', 'ben'], gruppen: null });
    expect(body.attendeeIds).toEqual(['anna']);
  });

  it('der Ersteller zählt weder bei den Personen noch bei den Teilnehmern', () => {
    expect(
      aendernBody(auswahl(['anna']), an, { teilnehmer: [ICH, 'anna'], gruppen: null }, ICH),
    ).toEqual({});
  });

  it('gibt den Schalter „Senden“ für die Neuen mit', () => {
    const body = aendernBody(
      auswahl(['anna', 'ben']),
      { senden: false, einzelchats: true },
      { teilnehmer: ['anna'], gruppen: null },
    );
    expect(body.zustellung?.senden).toBe(false);
  });
});

describe('vorbelegung', () => {
  const chats = [
    chat('g', 'group', [ich, anna, ben, clara], { titel: 'Skat' }),
    chat('d', 'direct', [ich, dora]),
    chat('allein', 'group', [ich], { titel: 'Allein' }),
  ];

  it('im Gruppenchat: alle Mitglieder ohne mich gewählt und der Chat als Ziel', () => {
    expect(vorbelegung(chats, 'g', ICH)).toEqual({
      personen: ['anna', 'ben', 'clara'],
      gruppen: ['g'],
      postenAus: [],
    });
  });

  it('im Einzelchat: das Gegenüber, kein Gruppenchat', () => {
    expect(vorbelegung(chats, 'd', ICH)).toEqual({
      personen: ['dora'],
      gruppen: [],
      postenAus: [],
    });
  });

  it('ohne Chat, mit unbekanntem Chat und im Chat ohne andere: niemand', () => {
    expect(vorbelegung(chats, null, ICH)).toEqual(niemand());
    expect(vorbelegung(chats, undefined, ICH)).toEqual(niemand());
    expect(vorbelegung(chats, 'gibt-es-nicht', ICH)).toEqual(niemand());
    expect(vorbelegung(chats, 'allein', ICH)).toEqual(niemand());
  });

  it('ein Gruppenchat über der Obergrenze wird nicht vorbelegt', () => {
    const gross = chat(
      'gross',
      'group',
      [
        ich,
        ...Array.from({ length: LIMITS.einladungenMax + 1 }, (_, i): [string, string] => [
          `u${i}`,
          `P${i}`,
        ]),
      ],
      { titel: 'Gross' },
    );
    expect(vorbelegung([gross], 'gross', ICH)).toEqual(niemand());
  });
});

describe('speichernText', () => {
  const zustellung = {
    gruppen: [{ conversationId: 'g', nachrichtId: 'm' }],
    einzelchats: 3,
    neueEinzelchats: 1,
    ausgelassen: [],
    ausstehend: 0,
    benachrichtigt: 3,
  };

  it('ohne Zustellung nur der Anfang', () => {
    expect(speichernText(true, undefined)).toBe('Termin erstellt');
    expect(speichernText(false, undefined)).toBe('Termin gespeichert');
  });

  it('nennt die Zahlen der Antwort', () => {
    expect(speichernText(true, zustellung)).toBe(
      'Termin erstellt – Karte im Gruppenchat, 3 Einzelchats, davon 1 neu angelegt.',
    );
  });

  it('beim Ändern steht die Gruppe nicht dabei: sie ist ein Stand, kein Ereignis', () => {
    expect(speichernText(false, { ...zustellung, neueEinzelchats: 0 })).toBe(
      'Termin gespeichert – 3 Einzelchats.',
    );
  });

  it('mehrere Gruppen und ausgelassene', () => {
    const text = speichernText(true, {
      ...zustellung,
      gruppen: [
        { conversationId: 'a', nachrichtId: null },
        { conversationId: 'b', nachrichtId: null },
      ],
      einzelchats: 1,
      neueEinzelchats: 0,
      ausgelassen: [{ conversationId: 'c', fehlend: ['x'] }],
    });
    expect(text).toBe(
      'Termin erstellt – Karten in 2 Gruppenchats, 1 Einzelchat, ein Gruppenchat ohne Karte, weil nicht alle Mitglieder eingeladen sind.',
    );
  });

  it('ausstehende Einladungen werden genannt', () => {
    const text = speichernText(true, { ...zustellung, ausstehend: 2 });
    expect(text).toContain('2 Einladungen konnten nicht zugestellt werden');
    expect(speichernText(true, { ...zustellung, ausstehend: 1 })).toContain(
      'Eine Einladung konnte nicht zugestellt werden',
    );
  });
});

describe('zeitOrtHinweis', () => {
  it('nennt, was sich geändert hat', () => {
    expect(zeitOrtHinweis('zeit')).toBe('Zeit geändert → alle Eingeladenen werden benachrichtigt.');
    expect(zeitOrtHinweis('ort')).toBe('Ort geändert → alle Eingeladenen werden benachrichtigt.');
    expect(zeitOrtHinweis('zeitUndOrt')).toBe(
      'Zeit und Ort geändert → alle Eingeladenen werden benachrichtigt.',
    );
  });
});

describe('terminOhneZustellung', () => {
  it('lässt die Meldung weg und behält den Termin', () => {
    const termin = terminOhneZustellung({
      id: 't',
      title: 'Grillen',
      zustellung: {
        gruppen: [],
        einzelchats: 0,
        neueEinzelchats: 0,
        ausgelassen: [],
        ausstehend: 0,
        benachrichtigt: 0,
      },
    } as never);
    expect(termin).toEqual({ id: 't', title: 'Grillen' });
  });
});
