import { describe, expect, it } from 'vitest';
import { CHAT_VOREINSTELLUNGEN, type ConversationDto } from '@initiative/shared';
import {
  abzeichen,
  darfAnheften,
  filterAusSchluessel,
  filterSchluessel,
  filtern,
  istUngelesen,
  reiterZahl,
  sortieren,
  STUMM_IMMER,
  stummBis,
  stummText,
  verschieben,
  wischErgebnis,
  wischVersatz,
} from './chatliste.js';

let zaehler = 0;
function chat(teil: Partial<ConversationDto> = {}): ConversationDto {
  zaehler += 1;
  return {
    id: `chat-${zaehler}`,
    type: 'group',
    title: `Chat ${zaehler}`,
    avatarUrl: null,
    createdBy: 'a',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    members: [],
    lastMessage: null,
    unreadCount: 0,
    verdeckterVerlauf: false,
    mutedUntil: null,
    archived: false,
    ...CHAT_VOREINSTELLUNGEN,
    ...teil,
  };
}

describe('filtern', () => {
  const gruppe = chat({ type: 'group', unreadCount: 2 });
  const direkt = chat({ type: 'direct' });
  const markiert = chat({ type: 'direct', markedUnread: true });
  const archiv = chat({ archived: true, unreadCount: 5 });
  const alle = [gruppe, direkt, markiert, archiv];

  it('Alle zeigt alles ausser dem Archiv', () => {
    expect(filtern(alle, { art: 'alle' })).toEqual([gruppe, direkt, markiert]);
  });
  it('Ungelesen zählt auch markierte, aber nichts aus dem Archiv', () => {
    expect(filtern(alle, { art: 'ungelesen' })).toEqual([gruppe, markiert]);
  });
  it('Gruppen und Direkt', () => {
    expect(filtern(alle, { art: 'gruppen' })).toEqual([gruppe]);
    expect(filtern(alle, { art: 'direkt' })).toEqual([direkt, markiert]);
  });
  it('Archiv zeigt nur Archiviertes', () => {
    expect(filtern(alle, { art: 'archiv' })).toEqual([archiv]);
  });
  it('ein Ordner zeigt seine Chats, unbekannte fallen heraus', () => {
    const ordner = [
      { id: 'o1', name: 'Arbeit', position: 0, chats: [direkt.id, 'weg', archiv.id] },
    ];
    expect(filtern(alle, { art: 'ordner', id: 'o1' }, ordner)).toEqual([direkt]);
    expect(filtern(alle, { art: 'ordner', id: 'fehlt' }, ordner)).toEqual([]);
  });
  it('Schlüssel hin und zurück', () => {
    expect(filterAusSchluessel(filterSchluessel({ art: 'ordner', id: 'x' }))).toEqual({
      art: 'ordner',
      id: 'x',
    });
    expect(filterAusSchluessel('gruppen')).toEqual({ art: 'gruppen' });
    expect(filterAusSchluessel('unsinn')).toEqual({ art: 'alle' });
    expect(filterAusSchluessel(null)).toEqual({ art: 'alle' });
  });
});

describe('sortieren', () => {
  it('Angeheftete oben (jüngste Nadel zuerst), dann nach Aktivität', () => {
    const alt = chat({ updatedAt: '2026-01-01T00:00:00Z' });
    const neu = chat({ updatedAt: '2026-03-01T00:00:00Z' });
    const nadel1 = chat({ pinnedAt: '2026-02-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    const nadel2 = chat({ pinnedAt: '2026-02-02T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    expect(sortieren([alt, nadel1, neu, nadel2]).map((c) => c.id)).toEqual([
      nadel2.id,
      nadel1.id,
      neu.id,
      alt.id,
    ]);
  });

  it('verschieben tauscht mit dem Nachbarn und bleibt am Rand stehen', () => {
    const a = chat({ pinnedAt: '2026-02-03T00:00:00Z' });
    const b = chat({ pinnedAt: '2026-02-02T00:00:00Z' });
    const c = chat({ pinnedAt: '2026-02-01T00:00:00Z' });
    const frei = chat();
    const liste = [frei, c, a, b];
    expect(verschieben(liste, b.id, 'hoch')).toEqual([b.id, a.id, c.id]);
    expect(verschieben(liste, b.id, 'runter')).toEqual([a.id, c.id, b.id]);
    expect(verschieben(liste, a.id, 'hoch')).toEqual([a.id, b.id, c.id]);
    expect(verschieben(liste, frei.id, 'hoch')).toEqual([a.id, b.id, c.id]);
  });

  it('höchstens fünf Nadeln', () => {
    const nadeln = Array.from({ length: 5 }, (_, i) =>
      chat({ pinnedAt: `2026-02-0${i + 1}T00:00:00Z` }),
    );
    const frei = chat();
    expect(darfAnheften([...nadeln, frei], frei)).toBe(false);
    expect(darfAnheften([...nadeln, frei], nadeln[0]!)).toBe(true);
    expect(darfAnheften([...nadeln.slice(1), frei], frei)).toBe(true);
  });
});

describe('Abzeichen', () => {
  it('Zahl, Punkt oder nichts', () => {
    expect(abzeichen(chat({ unreadCount: 3 }))).toEqual({ art: 'zahl', text: '3' });
    expect(abzeichen(chat({ unreadCount: 120 }))).toEqual({ art: 'zahl', text: '99+' });
    expect(abzeichen(chat({ markedUnread: true }))).toEqual({ art: 'punkt' });
    expect(abzeichen(chat())).toBeNull();
    expect(istUngelesen(chat({ markedUnread: true }))).toBe(true);
  });
  it('der Reiter zählt einen markierten Chat als eins, das Archiv nicht', () => {
    expect(
      reiterZahl([
        chat({ unreadCount: 2 }),
        chat({ markedUnread: true }),
        chat({ unreadCount: 2, markedUnread: true }),
        chat({ archived: true, unreadCount: 9 }),
      ]),
    ).toBe(5);
  });
});

describe('Stummschalten', () => {
  const jetzt = Date.parse('2026-05-01T10:00:00Z');
  it('Vorgaben', () => {
    expect(stummBis('8h', jetzt)).toBe('2026-05-01T18:00:00.000Z');
    expect(stummBis('1w', jetzt)).toBe('2026-05-08T10:00:00.000Z');
    expect(stummBis('immer', jetzt)).toBe(STUMM_IMMER);
  });
  it('Text', () => {
    expect(stummText(chat({ mutedUntil: STUMM_IMMER }), jetzt)).toBe(
      'Stumm, bis du es wieder einschaltest',
    );
    expect(stummText(chat({ mutedUntil: '2026-04-01T00:00:00Z' }), jetzt)).toBeNull();
    expect(stummText(chat({ mutedUntil: '2026-05-02T00:00:00Z' }), jetzt)).toMatch(/^Stumm bis /);
  });
});

describe('Wischen', () => {
  it('links archiviert, rechts liest – erst ab der Schwelle', () => {
    expect(wischErgebnis(-100, 5, 300)).toBe('archivieren');
    expect(wischErgebnis(100, 5, 300)).toBe('lesen');
    expect(wischErgebnis(50, 0, 300)).toBeNull();
    // Breite Zeile: ein Viertel der Breite.
    expect(wischErgebnis(-100, 0, 800)).toBeNull();
    expect(wischErgebnis(-210, 0, 800)).toBe('archivieren');
  });
  it('senkrechtes Blättern löst nichts aus', () => {
    expect(wischErgebnis(-100, 90, 300)).toBeNull();
    expect(wischVersatz(30, 60)).toBe(0);
  });
  it('die Zeile folgt begrenzt', () => {
    expect(wischVersatz(-500, 0)).toBe(-120);
    expect(wischVersatz(40, 10)).toBe(40);
  });
});
