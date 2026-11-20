/**
 * Die Zustandsmaschine eines 1:1-Anrufs auf dem Gerät – rein, ohne WebRTC.
 *
 * Die Nebenwirkungen (Mikrofon, Verbindung, Klingelton) hängen in
 * `anruf.ts` an den ÜBERGÄNGEN dieser Maschine. Hier steht nur, welcher
 * Zustand auf welches Ereignis folgt – und vor allem, was NICHT passieren
 * darf: Ein zweites Angebot während eines Gesprächs übernimmt nicht das
 * Gespräch, ein „angenommen“ von einem anderen Gerät beendet nur das
 * Klingeln, und Ereignisse eines alten Anrufs ändern den neuen nicht.
 */

export type Phase =
  /** Kein Anruf. */
  | 'ruhe'
  /** Eigener Anruf: Mikrofon/Kamera holen, Angebot bauen. */
  | 'waehlt'
  /** Eigener Anruf ist beim Server, es klingelt drüben. */
  | 'klingelt_aus'
  /** Eingehender Anruf klingelt hier. */
  | 'klingelt_ein'
  /** Angenommen, die Geräte suchen ihren Weg zueinander (ICE). */
  | 'verbindet'
  | 'verbunden'
  /** Vorbei – die Oberfläche zeigt kurz, warum. */
  | 'vorbei';

export type EndeGrund =
  | 'aufgelegt'
  | 'abgebrochen'
  | 'abgelehnt'
  | 'besetzt'
  | 'zeitlimit'
  | 'getrennt'
  | 'anderswo'
  | 'fehler';

export interface AnrufZustand {
  phase: Phase;
  anrufId: string | null;
  conversationId: string | null;
  /** Wer anruft (eingehend) bzw. angerufen wird (ausgehend). */
  gegenueber: string | null;
  video: boolean;
  richtung: 'aus' | 'ein' | null;
  /** Seit wann verbunden (ms) – für die Dauer. */
  verbundenSeit: number | null;
  grund: EndeGrund | null;
  /** Freier Text zum Grund (Fehlermeldung des Servers). */
  hinweis: string | null;
}

export const RUHE: AnrufZustand = {
  phase: 'ruhe',
  anrufId: null,
  conversationId: null,
  gegenueber: null,
  video: false,
  richtung: null,
  verbundenSeit: null,
  grund: null,
  hinweis: null,
};

export type Ereignis =
  | { typ: 'anrufen'; anrufId: string; conversationId: string; gegenueber: string; video: boolean }
  | { typ: 'gesendet'; anrufId: string }
  | {
      typ: 'angebot';
      anrufId: string;
      conversationId: string;
      von: string;
      video: boolean;
    }
  | { typ: 'annehmen'; anrufId: string }
  | { typ: 'antwort'; anrufId: string }
  | { typ: 'angenommen_anderswo'; anrufId: string }
  | { typ: 'verbunden'; anrufId: string; jetzt: number }
  | { typ: 'ende'; anrufId: string | null; grund: EndeGrund; hinweis?: string }
  | { typ: 'aufraeumen' };

/** Läuft gerade etwas (das ein neues Angebot nicht übernehmen darf)? */
export function istBelegt(zustand: AnrufZustand): boolean {
  return zustand.phase !== 'ruhe' && zustand.phase !== 'vorbei';
}

export function uebergang(zustand: AnrufZustand, ereignis: Ereignis): AnrufZustand {
  const passt = (id: string | null) => id !== null && id === zustand.anrufId;
  switch (ereignis.typ) {
    case 'anrufen':
      if (istBelegt(zustand)) return zustand;
      return {
        ...RUHE,
        phase: 'waehlt',
        anrufId: ereignis.anrufId,
        conversationId: ereignis.conversationId,
        gegenueber: ereignis.gegenueber,
        video: ereignis.video,
        richtung: 'aus',
      };
    case 'gesendet':
      return zustand.phase === 'waehlt' && passt(ereignis.anrufId)
        ? { ...zustand, phase: 'klingelt_aus' }
        : zustand;
    case 'angebot':
      // Belegt: Das Gespräch geht vor. (Der Server meldet „besetzt“ meist
      // schon selbst; das hier fängt den Rest – etwa ein zweites Gerät.)
      if (istBelegt(zustand)) return zustand;
      return {
        ...RUHE,
        phase: 'klingelt_ein',
        anrufId: ereignis.anrufId,
        conversationId: ereignis.conversationId,
        gegenueber: ereignis.von,
        video: ereignis.video,
        richtung: 'ein',
      };
    case 'annehmen':
      return zustand.phase === 'klingelt_ein' && passt(ereignis.anrufId)
        ? { ...zustand, phase: 'verbindet' }
        : zustand;
    case 'antwort':
      return (zustand.phase === 'klingelt_aus' || zustand.phase === 'waehlt') &&
        passt(ereignis.anrufId)
        ? { ...zustand, phase: 'verbindet' }
        : zustand;
    case 'angenommen_anderswo':
      // Nur das Klingeln hört auf – ein Gerät, das selbst angenommen hat,
      // ist schon in `verbindet` und bleibt dort.
      return zustand.phase === 'klingelt_ein' && passt(ereignis.anrufId)
        ? { ...zustand, phase: 'vorbei', grund: 'anderswo' }
        : zustand;
    case 'verbunden':
      return zustand.phase === 'verbindet' && passt(ereignis.anrufId)
        ? { ...zustand, phase: 'verbunden', verbundenSeit: ereignis.jetzt }
        : zustand;
    case 'ende':
      if (!istBelegt(zustand)) return zustand;
      // Ohne Kennung (eigener Fehler vor dem Senden) gilt es dem laufenden.
      if (ereignis.anrufId !== null && !passt(ereignis.anrufId)) return zustand;
      return {
        ...zustand,
        phase: 'vorbei',
        grund: ereignis.grund,
        hinweis: ereignis.hinweis ?? null,
      };
    case 'aufraeumen':
      return zustand.phase === 'vorbei' ? RUHE : zustand;
  }
}

/** Was die Oberfläche zum Ende sagt. */
export function endeText(grund: EndeGrund | null, richtung: 'aus' | 'ein' | null): string {
  switch (grund) {
    case 'aufgelegt':
      return 'Anruf beendet';
    case 'abgebrochen':
      return richtung === 'ein' ? 'Verpasster Anruf' : 'Anruf abgebrochen';
    case 'abgelehnt':
      return richtung === 'aus' ? 'Abgelehnt' : 'Anruf abgelehnt';
    case 'besetzt':
      return 'Besetzt';
    case 'zeitlimit':
      return richtung === 'aus' ? 'Keine Antwort' : 'Verpasster Anruf';
    case 'getrennt':
      return 'Verbindung verloren';
    case 'anderswo':
      return 'Auf einem anderen Gerät angenommen';
    case 'fehler':
      return 'Anruf nicht möglich';
    default:
      return 'Anruf beendet';
  }
}

/**
 * Verbindungsqualität aus Rundlaufzeit (ms) und Verlust (0..1) –
 * grob, wie eine Balkenanzeige.
 */
export function qualitaet(
  rttMs: number | null,
  verlust: number | null,
): 'gut' | 'mittel' | 'schlecht' | null {
  if (rttMs === null && verlust === null) return null;
  const r = rttMs ?? 0;
  const v = verlust ?? 0;
  if (r > 600 || v > 0.1) return 'schlecht';
  if (r > 250 || v > 0.03) return 'mittel';
  return 'gut';
}
