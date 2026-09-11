import { describe, expect, it } from 'vitest';
import type { ConversationDto, ConversationMemberDto, VerlaufsantragDto } from '@initiative/shared';
import { eigeneLage, fremdeAntraege } from './verlaufBand.js';

const ICH = 'aaaaaaaa-0000-0000-0000-000000000001';
const DU = 'bbbbbbbb-0000-0000-0000-000000000002';
const ER = 'cccccccc-0000-0000-0000-000000000003';

function mitglied(userId: string, siehtAb: string | null): ConversationMemberDto {
  return {
    userId,
    role: 'member',
    joinedAt: '2026-01-01T00:00:00Z',
    nickname: null,
    lastReadMessageId: null,
    siehtAb,
    user: {
      id: userId,
      username: userId.slice(0, 4),
      displayName: userId.slice(0, 4),
      avatarUrl: null,
      lastSeenAt: null,
    } as ConversationDto['members'][number]['user'],
  };
}

function chat(members: ConversationMemberDto[], verdeckterVerlauf = true): ConversationDto {
  return {
    verdeckterVerlauf,
    id: 'dddddddd-0000-0000-0000-000000000009',
    type: 'group',
    title: 'Test',
    avatarUrl: null,
    createdBy: DU,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    members,
    lastMessage: null,
    unreadCount: 0,
    mutedUntil: null,
    archived: false,
  };
}

function antrag(von: string, teil: Partial<VerlaufsantragDto> = {}): VerlaufsantragDto {
  return {
    id: 'eeeeeeee-0000-0000-0000-000000000001',
    conversationId: 'dddddddd-0000-0000-0000-000000000009',
    antragsteller: von,
    status: 'offen',
    offenBei: [],
    zugestimmt: [],
    abgelehnt: [],
    ...teil,
  };
}

describe('eigeneLage', () => {
  it('sagt nichts, wenn ich den ganzen Verlauf sehe', () => {
    const c = chat([mitglied(ICH, null), mitglied(DU, null)]);
    expect(eigeneLage(c, [], ICH).art).toBe('sieht-alles');
  });

  it('bietet den Antrag an, wenn meine Grenze steht', () => {
    const c = chat([mitglied(ICH, '2026-05-01T00:00:00Z'), mitglied(DU, null)]);
    const lage = eigeneLage(c, [], ICH);
    expect(lage.art).toBe('kann-beantragen');
    expect(lage.art === 'kann-beantragen' && lage.seit).toBe('2026-05-01T00:00:00Z');
  });

  it('zeigt den Stand, solange mein Antrag laeuft', () => {
    const c = chat([mitglied(ICH, '2026-05-01T00:00:00Z'), mitglied(DU, null), mitglied(ER, null)]);
    const lage = eigeneLage(c, [antrag(ICH, { zugestimmt: [DU], offenBei: [ER] })], ICH);
    expect(lage.art).toBe('beantragt');
    expect(lage.art === 'beantragt' && lage.zugestimmt).toBe(1);
    expect(lage.art === 'beantragt' && lage.offen).toBe(1);
  });

  /*
   * Der Antrag eines anderen darf meinen Knopf nicht verschlucken. Vorher
   * fragte die Suche nur nach „gibt es einen offenen Antrag" – dann hätte
   * Bernds Antrag meinen eigenen Knopf verdeckt, obwohl ich gar nichts
   * beantragt habe.
   */
  it('verwechselt den Antrag eines anderen nicht mit meinem', () => {
    const c = chat([mitglied(ICH, '2026-05-01T00:00:00Z'), mitglied(DU, '2026-06-01T00:00:00Z')]);
    expect(eigeneLage(c, [antrag(DU, { offenBei: [ICH] })], ICH).art).toBe('kann-beantragen');
  });

  it('bietet keinen Antrag an, wenn niemand mehr da ist zum Zustimmen', () => {
    const c = chat([mitglied(ICH, '2026-05-01T00:00:00Z')]);
    expect(eigeneLage(c, [], ICH).art).toBe('niemand-da');
  });

  it('sagt nichts, solange der Chat noch nicht geladen ist', () => {
    expect(eigeneLage(null, [], ICH).art).toBe('sieht-alles');
  });

  /*
   * Auch der Gründer bekommt eine Grenze gesetzt – die Regel lautet überall
   * „du siehst ab jetzt". Entschiede die Anzeige am gesetzten Feld statt am
   * Inhalt, böte sie ihm an, einen Verlauf zu beantragen, den es nicht gibt.
   */
  it('bietet nichts an, wenn hinter der Grenze nichts liegt', () => {
    const c = chat([mitglied(ICH, '2026-05-01T00:00:00Z'), mitglied(DU, null)], false);
    expect(eigeneLage(c, [], ICH).art).toBe('sieht-alles');
  });
});

describe('fremdeAntraege', () => {
  it('fragt mich nach meiner Stimme', () => {
    const liste = fremdeAntraege([antrag(DU, { offenBei: [ICH, ER] })], ICH);
    expect(liste).toHaveLength(1);
    expect(liste[0].meineStimme).toBeNull();
  });

  it('zeigt meine abgegebene Stimme weiter an – sie laesst sich noch aendern', () => {
    const liste = fremdeAntraege([antrag(DU, { zugestimmt: [ICH], offenBei: [ER] })], ICH);
    expect(liste[0].meineStimme).toBe('ja');
  });

  it('laesst den eigenen Antrag weg – ueber den stimmt man nicht ab', () => {
    expect(fremdeAntraege([antrag(ICH, { offenBei: [DU] })], ICH)).toHaveLength(0);
  });

  it('laesst entschiedene Antraege weg', () => {
    const erledigt = antrag(DU, { status: 'angenommen', zugestimmt: [ICH] });
    expect(fremdeAntraege([erledigt], ICH)).toHaveLength(0);
  });

  /*
   * Wer in keiner der drei Listen steht, ist kein Wähler – ihm einen Knopf zu
   * zeigen, der mit 403 endet, wäre eine Lüge.
   */
  it('fragt nicht, wen der Server gar nicht fragt', () => {
    expect(fremdeAntraege([antrag(DU, { offenBei: [ER] })], ICH)).toHaveLength(0);
  });

  it('stellt die unbeantworteten nach vorn', () => {
    const beantwortet = antrag(DU, {
      id: 'eeeeeeee-0000-0000-0000-00000000000a',
      zugestimmt: [ICH],
    });
    const offen = antrag(ER, { id: 'eeeeeeee-0000-0000-0000-00000000000b', offenBei: [ICH] });
    const liste = fremdeAntraege([beantwortet, offen], ICH);
    expect(liste.map((eintrag) => eintrag.antrag.antragsteller)).toEqual([ER, DU]);
  });
});
