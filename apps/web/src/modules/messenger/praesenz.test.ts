import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { shallow } from 'zustand/shallow';
import type { ConversationDto } from '@initiative/shared';
import type { ChatMessage } from '../../state/chat.js';
import {
  blasenPropsGleich,
  gegenueberIds,
  onlineUnter,
  praesenzVon,
  type BlasenProps,
  type PraesenzKarte,
} from './praesenz.js';

/*
 * Ohne DOM lässt sich nicht zählen, wie oft React zeichnet – wohl aber, wie
 * oft ein Selektor etwas ANDERES liefert. Genau das entscheidet in `useChat`
 * über ein neues Zeichnen (Vergleich mit `Object.is` bzw. `useShallow`).
 * `zaehle` spielt eine Folge von Zustandsänderungen durch und zählt die
 * Wechsel – das ist die Zahl der Neuzeichnungen, die das Abo auslöst.
 */
function zaehle<T>(
  folge: ((karte: PraesenzKarte) => PraesenzKarte)[],
  auswahl: (karte: PraesenzKarte) => T,
  gleich: (a: T, b: T) => boolean = Object.is,
): number {
  const laden = createStore<{ presence: PraesenzKarte }>(() => ({ presence: {} }));
  let letzter = auswahl(laden.getState().presence);
  let wechsel = 0;
  laden.subscribe((zustand) => {
    const neu = auswahl(zustand.presence);
    if (!gleich(letzter, neu)) wechsel += 1;
    letzter = neu;
  });
  for (const schritt of folge) laden.setState((z) => ({ presence: schritt(z.presence) }));
  return wechsel;
}

/** So wie `state/chat.ts` eine Präsenzmeldung einträgt. */
const meldung =
  (userId: string, online: boolean, lastSeenAt: string | null = null) =>
  (karte: PraesenzKarte): PraesenzKarte => ({ ...karte, [userId]: { online, lastSeenAt } });

const folge = [
  meldung('anna', true),
  meldung('dritter', true),
  meldung('vierter', true),
  meldung('dritter', false, '2026-10-30T10:00:00Z'),
  meldung('anna', false, '2026-10-30T10:05:00Z'),
  meldung('fuenfter', true),
];

function chat(id: string, type: 'direct' | 'group', userIds: string[]): ConversationDto {
  return {
    id,
    type,
    members: userIds.map((userId) => ({ userId, user: { id: userId } })),
  } as unknown as ConversationDto;
}

describe('praesenzVon – der offene Chat', () => {
  it('liefert nur bei Meldungen des Gegenübers etwas Neues', () => {
    // Vorher: die ganze Karte abonniert – jede Meldung zeichnet neu.
    expect(zaehle(folge, (karte) => karte)).toBe(6);
    // Jetzt: nur Annas Eintrag – zwei Meldungen von Anna, zwei Neuzeichnungen.
    expect(zaehle(folge, (karte) => praesenzVon(karte, 'anna'))).toBe(2);
  });

  it('liefert in einer Gruppe (kein Gegenüber) nie etwas', () => {
    expect(zaehle(folge, (karte) => praesenzVon(karte, null))).toBe(0);
    expect(praesenzVon({ x: { online: true, lastSeenAt: null } }, undefined)).toBeUndefined();
  });
});

describe('onlineUnter – die Chatliste', () => {
  const ids = gegenueberIds(
    [
      chat('c1', 'direct', ['ich', 'anna']),
      chat('c2', 'group', ['ich', 'dritter', 'vierter']),
      chat('c3', 'direct', ['ich', 'bert']),
    ],
    'ich',
  );

  it('nimmt nur die Gegenüber der Einzelchats', () => {
    expect(ids).toEqual(['anna', 'bert']);
  });

  it('zeichnet nur neu, wenn ein gezeigter Punkt wechselt', () => {
    expect(zaehle(folge, (karte) => onlineUnter(karte, ids), shallow)).toBe(2);
  });

  it('übersieht ein bloss verschobenes „zuletzt gesehen"', () => {
    const schritte = [
      meldung('anna', false, '2026-10-30T09:00:00Z'),
      meldung('anna', false, '2026-10-30T09:10:00Z'),
    ];
    expect(zaehle(schritte, (karte) => onlineUnter(karte, ids), shallow)).toBe(0);
  });

  it('hält die Reihenfolge der Liste ein', () => {
    const karte: PraesenzKarte = {
      bert: { online: true, lastSeenAt: null },
      anna: { online: true, lastSeenAt: null },
    };
    expect(onlineUnter(karte, ids)).toEqual(['anna', 'bert']);
  });
});

describe('blasenPropsGleich – memo der Blase', () => {
  const nachricht = { id: 'm1' } as ChatMessage;
  const basis = chat('c1', 'group', ['ich', 'anna']);
  const oeffnen = () => {};
  const springen = () => {};
  const props = (teil: Partial<BlasenProps> = {}): BlasenProps => ({
    message: nachricht,
    conversation: basis,
    showSender: true,
    showAvatar: true,
    onOpenActions: oeffnen,
    onJumpTo: springen,
    ...teil,
  });

  it('übergeht einen neu gebauten Chat mit denselben Mitgliedern', () => {
    // So baut `applyMessage` den Chat bei jeder neuen Nachricht neu.
    const nachNeuerNachricht = { ...basis, lastMessage: null, unreadCount: 3 };
    expect(blasenPropsGleich(props(), props({ conversation: nachNeuerNachricht }))).toBe(true);
  });

  it('zeichnet neu, wenn sich Mitglieder oder die Art ändern', () => {
    const gelesen = { ...basis, members: basis.members.map((m) => ({ ...m })) };
    expect(blasenPropsGleich(props(), props({ conversation: gelesen }))).toBe(false);
    const alsEinzel = { ...basis, type: 'direct' } as ConversationDto;
    expect(blasenPropsGleich(props(), props({ conversation: alsEinzel }))).toBe(false);
    expect(blasenPropsGleich(props(), props({ conversation: null }))).toBe(false);
  });

  it('zeichnet neu bei neuer Nachricht, neuer Gruppierung oder neuen Rückrufen', () => {
    expect(blasenPropsGleich(props(), props({ message: { id: 'm1' } as ChatMessage }))).toBe(false);
    expect(blasenPropsGleich(props(), props({ showAvatar: false }))).toBe(false);
    expect(blasenPropsGleich(props(), props({ onJumpTo: () => {} }))).toBe(false);
  });
});
