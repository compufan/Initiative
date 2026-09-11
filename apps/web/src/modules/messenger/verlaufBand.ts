/**
 * Was der Verlaufsstreifen anzeigen soll – als reine Rechnung.
 *
 * Die Regel selbst steht im Server (`services/verlauf.rs`): Wer neu dazukommt,
 * sieht ab seinem Beitritt; alles davor gibt es auf Antrag, und **alle**
 * anderen müssen zustimmen. Hier wird nur entschieden, welcher Satz daraus für
 * mich gerade gilt.
 *
 * Zwei getrennte Fragen, deshalb zwei getrennte Funktionen: „Was ist meine
 * Lage?" gehört an den Anfang des Verlaufs, wo er aufhört – „Wer wartet auf
 * meine Stimme?" gehört unter die Kopfzeile, weil es eine Handlung von mir
 * verlangt. Zusammengelegt gäbe das einen Zustand mit sechs Ausprägungen, von
 * denen die Hälfte gleichzeitig zutreffen kann.
 */
import type { ConversationDto, VerlaufsantragDto } from '@initiative/shared';

export type EigeneLage =
  /** Ich sehe den ganzen Verlauf – es gibt nichts zu beantragen. */
  | { art: 'sieht-alles' }
  /** Ich sehe erst ab meinem Beitritt und kann den Rest beantragen. */
  | { art: 'kann-beantragen'; seit: string }
  /** Mein Antrag läuft. */
  | { art: 'beantragt'; antrag: VerlaufsantragDto; offen: number; zugestimmt: number }
  /**
   * Ich sehe erst ab meinem Beitritt, aber es ist niemand mehr da, der
   * zustimmen könnte. Ein Antrag wäre eine Abstimmung ohne Wähler; der Server
   * lehnt ihn ab. Die Auskunft ist trotzdem fällig – sonst stünde da ein
   * abgeschnittener Verlauf ohne Erklärung.
   */
  | { art: 'niemand-da'; seit: string };

export function eigeneLage(
  conversation: ConversationDto | null,
  antraege: VerlaufsantragDto[],
  myId: string,
): EigeneLage {
  /*
   * Gefragt wird, ob etwas verdeckt IST – nicht, ob eine Grenze gesetzt ist.
   * Eine Grenze bekommt auch, wer das Gespräch gründet; ihm einen Antrag auf
   * den Verlauf anzubieten, hiesse ihn nach etwas fragen zu lassen, das es
   * nicht gibt.
   */
  const ich = conversation?.members.find((mitglied) => mitglied.userId === myId);
  if (!conversation || !conversation.verdeckterVerlauf || !ich || ich.siehtAb == null) {
    return { art: 'sieht-alles' };
  }

  const meiner = antraege.find(
    (antrag) => antrag.antragsteller === myId && antrag.status === 'offen',
  );
  if (meiner) {
    return {
      art: 'beantragt',
      antrag: meiner,
      offen: meiner.offenBei.length,
      zugestimmt: meiner.zugestimmt.length,
    };
  }

  const andere = (conversation?.members.length ?? 0) - 1;
  if (andere < 1) return { art: 'niemand-da', seit: ich.siehtAb };
  return { art: 'kann-beantragen', seit: ich.siehtAb };
}

export interface FremderAntrag {
  antrag: VerlaufsantragDto;
  /** Meine Stimme – `null`, solange ich nicht abgestimmt habe. */
  meineStimme: 'ja' | 'nein' | null;
}

/**
 * Anträge anderer, zu denen ich gehört werde – die unbeantworteten zuerst.
 *
 * Wer schon abgestimmt hat, bekommt den Streifen weiter zu sehen, aber weiter
 * unten: Eine Stimme lässt sich ändern, solange nicht entschieden ist, und ein
 * Streifen, der nach der eigenen Stimme verschwindet, nähme einem genau diese
 * Möglichkeit.
 */
export function fremdeAntraege(antraege: VerlaufsantragDto[], myId: string): FremderAntrag[] {
  const meine = antraege
    .filter((antrag) => antrag.status === 'offen' && antrag.antragsteller !== myId)
    .map((antrag): FremderAntrag => {
      let meineStimme: 'ja' | 'nein' | null = null;
      if (antrag.zugestimmt.includes(myId)) meineStimme = 'ja';
      else if (antrag.abgelehnt.includes(myId)) meineStimme = 'nein';
      return { antrag, meineStimme };
    })
    /*
     * Anträge aus Gesprächen, in denen ich gar nicht gefragt bin, kämen hier
     * nicht an – der Server listet nur die des geöffneten Gesprächs. Wer
     * dennoch in keiner der drei Listen steht, ist kein Wähler; ihm einen
     * Zustimmen-Knopf zu zeigen, der mit 403 endet, wäre eine Lüge.
     */
    .filter(
      ({ antrag, meineStimme }) => meineStimme !== null || antrag.offenBei.includes(myId),
    );

  return meine.sort((a, b) => {
    if ((a.meineStimme === null) !== (b.meineStimme === null)) return a.meineStimme === null ? -1 : 1;
    return a.antrag.id < b.antrag.id ? -1 : 1;
  });
}
