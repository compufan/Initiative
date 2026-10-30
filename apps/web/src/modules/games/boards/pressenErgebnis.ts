import { istVerborgen, type PressenAnsicht, type PressenErgebnis } from '@initiative/shared';

/**
 * Wie das Ergebnis einer Runde gesagt wird – aus Sicht dessen, der zuschaut.
 *
 *  - `sieg`        „Du hast gewonnen“
 *  - `niederlage`  „Du wurdest abgeschluckt“
 *  - `atempo`      „Atempo“: der Unterschied lag innerhalb der Toleranz, es geht
 *                  noch einmal los (im Spiegel IMMER)
 *  - `neutral`     ohne Sitz („X hat gewonnen“) oder als Ampel, die nicht gewertet wird
 *
 * Reine Funktion ohne Oberfläche, damit sich die Sprache testen lässt.
 *
 * WARUM die Sichtbarkeitsregel hier nicht noch einmal geprüft wird: Der Server
 * liefert fremde Zeiten erst, wenn die Runde entschieden ist (`fuer_betrachter`).
 * Solange etwas „verborgen“ ist, erscheint hier schlicht keine Zeile – es gibt
 * nichts, das man versehentlich zeigen könnte.
 */
export type ErgebnisArt = 'sieg' | 'niederlage' | 'atempo' | 'neutral';

export interface ErgebnisZeile {
  sitz: number;
  name: string;
  /** Die eigene Zeile wird hervorgehoben. */
  ich: boolean;
  sieger: boolean;
  /** „Ampel“, „Team A“ … – leer, wenn es keine Rolle gibt. */
  rolle: string | null;
  nichtGewertet: boolean;
  dauerMs: number;
  verschuettetDezi: number;
  /** Der Score: Zeit plus Strafe fürs Verschütten (kleiner ist besser). */
  wertungMs: number;
  getruemmert: boolean;
}

export interface ErgebnisAnzeige {
  art: ErgebnisArt;
  titel: string;
  untertitel: string | null;
  zeilen: ErgebnisZeile[];
  /** Überschrift der Liste: „Endwertung“ oder „Runde 3“. */
  listenTitel: string;
}

const sekunden = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

function offen(
  e: PressenErgebnis | { verborgen: true } | null | undefined,
): PressenErgebnis | null {
  return e && !istVerborgen(e) ? e : null;
}

function rolleVon(state: PressenAnsicht, sitz: number): string | null {
  if (state.ampel === sitz) return 'Ampel';
  if (state.modus === 'staffette') {
    const team = state.teams.findIndex((t) => t.includes(sitz));
    return team >= 0 ? `Team ${'AB'[team]}` : null;
  }
  return null;
}

/** „Anna“, „Anna und Bodo“, „Anna, Bodo und Cleo“. */
export function aufzaehlung(namen: string[]): string {
  if (namen.length <= 1) return namen[0] ?? '';
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * Das Ergebnis, das der Betrachter jetzt sehen soll – oder `null`, wenn es
 * (noch) keines gibt: mitten in der Runde, oder ganz zu Beginn.
 *
 * Zwei Fälle haben ein Ergebnis:
 *  1. Die Partie ist entschieden (`fertig`): Sieg oder Niederlage.
 *  2. Die letzte Runde ging unentschieden aus (Atempo) und die neue läuft noch
 *     nicht: Dann steht die Vorrunde in `vorrunde`.
 */
export function ergebnisAnzeige(
  state: PressenAnsicht,
  mySeat: number | null,
  nameVon: (sitz: number) => string,
): ErgebnisAnzeige | null {
  const entschieden = state.fertig;
  const atempoPause =
    !entschieden &&
    state.atempo > 0 &&
    state.vorrunde != null &&
    state.ergebnisse.every((e) => e == null);
  if (!entschieden && !atempoPause) return null;

  const liste = (entschieden ? state.ergebnisse : state.vorrunde) ?? [];
  const zeilen: ErgebnisZeile[] = [];
  liste.forEach((roh, sitz) => {
    const e = offen(roh);
    if (!e) return;
    zeilen.push({
      sitz,
      name: nameVon(sitz),
      ich: sitz === mySeat,
      sieger: entschieden && state.sieger.includes(sitz),
      rolle: rolleVon(state, sitz),
      nichtGewertet: state.ampel === sitz,
      dauerMs: e.dauerMs,
      verschuettetDezi: e.verschuettetDezi,
      wertungMs: e.wertungMs,
      getruemmert: e.getruemmert,
    });
  });
  const listenTitel = entschieden ? 'Endwertung' : `Runde ${state.runde - 1}`;

  if (atempoPause) {
    const spiegel = state.modus === 'spiegel';
    return {
      art: 'atempo',
      titel: 'Atempo',
      untertitel: spiegel
        ? `Gegen den Spiegel gibt es immer Atempo – weiter mit Runde ${state.runde}.`
        : `Nur ${state.letzterAbstandMs ?? 0} ms Unterschied – ihr tretet noch einmal an (Runde ${state.runde}).`,
      zeilen,
      listenTitel,
    };
  }

  const teamZeile =
    state.modus === 'staffette' && state.teamWertung && state.teamWertung.length >= 2
      ? `Team A ${sekunden(state.teamWertung[0]!)} : Team B ${sekunden(state.teamWertung[1]!)}`
      : null;

  const imTeam = mySeat != null && state.teams.some((team) => team.includes(mySeat));
  if (mySeat != null && imTeam) {
    const gewonnen = state.sieger.includes(mySeat);
    return {
      art: gewonnen ? 'sieg' : 'niederlage',
      titel: gewonnen ? 'Du hast gewonnen' : 'Du wurdest abgeschluckt',
      untertitel: teamZeile,
      zeilen,
      listenTitel,
    };
  }

  // Zuschauer oder die Ampel, die nicht gewertet wird: sachlich sagen, wer gewonnen hat.
  const siegerTeam = state.teams.findIndex((team) => team.some((s) => state.sieger.includes(s)));
  const gewinner =
    state.modus === 'staffette' && siegerTeam >= 0
      ? [`Team ${'AB'[siegerTeam]}`]
      : state.sieger.map(nameVon);
  return {
    art: 'neutral',
    titel: `${aufzaehlung(gewinner)} ${gewinner.length > 1 ? 'haben' : 'hat'} gewonnen`,
    untertitel: teamZeile,
    zeilen,
    listenTitel,
  };
}

/** Ein Satz für Vorlesehilfen: das Ergebnis samt der eigenen Zeile. */
export function ergebnisAnsage(anzeige: ErgebnisAnzeige): string {
  const ich = anzeige.zeilen.find((z) => z.ich);
  const eigene = ich
    ? ` Deine Zeit ${sekunden(ich.dauerMs)}, ${(ich.verschuettetDezi / 10).toFixed(1).replace('.', ',')} Milliliter verschüttet, Wertung ${sekunden(ich.wertungMs)}.`
    : '';
  const untertitel = anzeige.untertitel
    ? ` ${anzeige.untertitel}${/[.!?]$/.test(anzeige.untertitel) ? '' : '.'}`
    : '';
  return `${anzeige.titel}.${untertitel}${eigene}`;
}
