import { useRef } from 'react';

import type { Stueck } from './ausschnitt.js';

/**
 * Ein Filmstreifen mit Griffen.
 *
 * # Warum ein Streifen und keine Zeitleiste
 *
 * Weil niemand weiss, was bei Sekunde 4,2 passiert. Eine Leiste mit zwei
 * Griffen ist schneller gebaut und zwingt dazu, blind zu schieben und immer
 * wieder vorzuhören. Acht Standbilder darunter beantworten dieselbe Frage auf
 * einen Blick.
 *
 * Steht in einer eigenen Datei, weil zwei Blätter ihn brauchen: „GIF aus
 * Video" und die Videobearbeitung. Beide stellen dieselbe Frage – welcher
 * Ausschnitt? – und eine zweite Fassung davon wäre eine zweite Stelle, an der
 * die Tastaturbedienung fehlt.
 *
 * # Warum mehrere Stücke, aber immer nur EIN Paar Griffe
 *
 * Weil der Film aus mehreren Stücken bestehen darf – das ist der Kern der
 * Schnittoptionen. Alle Stücke zugleich mit Griffen auszustatten wäre
 * trotzdem falsch: Zwei Stücke, die sich berühren, hätten dort vier Griffe
 * übereinander, und eine Fingerkuppe trifft keinen davon sicher. Sichtbar
 * sind deshalb alle Stücke, fassbar ist das ausgewählte; ein Tipp auf ein
 * anderes wählt es aus.
 */
export function Streifen({
  bilder,
  dauerMs,
  stuecke,
  aktiv,
  gesperrt,
  schrittMs = 100,
  spielkopfMs,
  onBereich,
  onAktiv,
  onSpielkopf,
}: {
  bilder: { zeitMs: number; bild: string }[];
  dauerMs: number;
  stuecke: readonly Stueck[];
  /** Welches Stück die Griffe bedienen. */
  aktiv: number;
  gesperrt: boolean;
  /**
   * Wie weit ein Tastendruck schiebt – ein Bild weit.
   *
   * Feste hundert Millisekunden wären bei 60 Bildern je Sekunde sechs Bilder
   * auf einmal; bildgenau zu schneiden ginge damit gar nicht.
   */
  schrittMs?: number;
  /**
   * Die Wiedergabestelle, falls es eine gibt – ohne Angabe kein Strich.
   *
   * Optional, damit „GIF aus Video" (das den Streifen auch benutzt, aber
   * keine Wiedergabe hat) unverändert bleibt.
   */
  spielkopfMs?: number;
  onBereich: (vonMs: number, bisMs: number) => void;
  onAktiv?: (nummer: number) => void;
  /**
   * Ein Tipp oder ein Ziehen auf dem GRUND des Streifens – nicht auf einem
   * Griff oder einem Stück, die fangen ihren eigenen Druck ab (siehe dort).
   * Ohne diese Angabe bleibt der Streifen ein reiner Bereichswähler, wie
   * bisher.
   */
  onSpielkopf?: (ms: number) => void;
}) {
  const bahn = useRef<HTMLDivElement | null>(null);
  const zieht = useRef<'von' | 'bis' | null>(null);
  const ziehtKopf = useRef(false);

  const stueck = stuecke[aktiv] ?? { vonMs: 0, bisMs: dauerMs };
  /* Mindestens ein Bild lang – ein Stück ohne Länge liefert trotzdem eines. */
  const mindest = Math.max(1, Math.round(schrittMs));

  const zeitAus = (klientX: number): number => {
    const kasten = bahn.current?.getBoundingClientRect();
    if (!kasten || kasten.width === 0) return 0;
    const anteil = Math.min(1, Math.max(0, (klientX - kasten.left) / kasten.width));
    return Math.round(anteil * dauerMs);
  };

  const schieben = (klientX: number) => {
    const zeit = zeitAus(klientX);
    if (zieht.current === 'von') onBereich(Math.min(zeit, stueck.bisMs - mindest), stueck.bisMs);
    else if (zieht.current === 'bis')
      onBereich(stueck.vonMs, Math.max(zeit, stueck.vonMs + mindest));
  };

  const anteil = (ms: number) => (dauerMs > 0 ? Math.min(1, Math.max(0, ms / dauerMs)) : 0);
  const anteilVon = anteil(stueck.vonMs);
  const anteilBis = anteil(stueck.bisMs);

  return (
    <div
      className={`vg-streifen${gesperrt ? ' ist-aus' : ''}`}
      ref={bahn}
      onPointerDown={(ereignis) => {
        // Nur der GRUND – ein Griff oder ein Stück hat den Druck über
        // `stopPropagation` schon für sich behalten.
        if (!onSpielkopf || gesperrt) return;
        ziehtKopf.current = true;
        ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
        onSpielkopf(zeitAus(ereignis.clientX));
      }}
      onPointerMove={(ereignis) => {
        if (zieht.current) schieben(ereignis.clientX);
        else if (ziehtKopf.current && onSpielkopf) onSpielkopf(zeitAus(ereignis.clientX));
      }}
      onPointerUp={() => {
        zieht.current = null;
        ziehtKopf.current = false;
      }}
      onPointerLeave={() => {
        zieht.current = null;
        ziehtKopf.current = false;
      }}
    >
      {bilder.map((bild) => (
        <img key={bild.zeitMs} src={bild.bild} alt="" aria-hidden="true" />
      ))}

      {/* Alles, was in keinem Stück liegt, wird abgedunkelt – nicht
          ausgeblendet: Man muss sehen, was man gerade NICHT nimmt, um den
          Griff dorthin zu ziehen. */}
      {luecken(stuecke, dauerMs).map((luecke) => (
        <div
          key={`${luecke.vonMs}-${luecke.bisMs}`}
          className="vg-schatten"
          style={{
            left: `${anteil(luecke.vonMs) * 100}%`,
            width: `${(anteil(luecke.bisMs) - anteil(luecke.vonMs)) * 100}%`,
          }}
        />
      ))}

      {stuecke.length > 1 &&
        stuecke.map((eintrag, nummer) => (
          <button
            key={`${nummer}-${eintrag.vonMs}`}
            type="button"
            className={`vg-stueck${nummer === aktiv ? ' ist-aktiv' : ''}`}
            style={{
              left: `${anteil(eintrag.vonMs) * 100}%`,
              width: `${Math.max(0, anteil(eintrag.bisMs) - anteil(eintrag.vonMs)) * 100}%`,
            }}
            disabled={gesperrt}
            aria-label={`Stück ${nummer + 1} auswählen`}
            aria-pressed={nummer === aktiv}
            onPointerDown={(ereignis) => {
              ereignis.stopPropagation();
              onAktiv?.(nummer);
            }}
          >
            <span aria-hidden="true">{nummer + 1}</span>
          </button>
        ))}

      {spielkopfMs !== undefined && (
        <div className="vg-spielkopf" style={{ left: `${anteil(spielkopfMs) * 100}%` }} />
      )}

      {(['von', 'bis'] as const).map((welcher) => (
        <button
          key={welcher}
          type="button"
          className="vg-griff"
          style={{ left: `${(welcher === 'von' ? anteilVon : anteilBis) * 100}%` }}
          disabled={gesperrt}
          aria-label={welcher === 'von' ? 'Anfang' : 'Ende'}
          onPointerDown={(ereignis) => {
            ereignis.stopPropagation();
            zieht.current = welcher;
            ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
          }}
          onPointerMove={(ereignis) => {
            if (zieht.current) schieben(ereignis.clientX);
          }}
          onPointerUp={() => {
            zieht.current = null;
          }}
          onKeyDown={(ereignis) => {
            // Mit der Tastatur bedienbar: Ein Griff, den man nur ziehen kann,
            // ist für jeden ohne Maus oder Finger gar kein Griff.
            const schritt = ereignis.shiftKey ? mindest * 10 : mindest;
            if (ereignis.key === 'ArrowLeft' || ereignis.key === 'ArrowRight') {
              ereignis.preventDefault();
              const richtung = ereignis.key === 'ArrowLeft' ? -schritt : schritt;
              if (welcher === 'von') {
                onBereich(
                  Math.max(0, Math.min(stueck.vonMs + richtung, stueck.bisMs - mindest)),
                  stueck.bisMs,
                );
              } else {
                onBereich(
                  stueck.vonMs,
                  Math.min(dauerMs, Math.max(stueck.bisMs + richtung, stueck.vonMs + mindest)),
                );
              }
            }
          }}
        />
      ))}
    </div>
  );
}

/**
 * Was der Streifen abdunkelt: alles, was in keinem Stück liegt.
 *
 * Steht als eigene Funktion da, weil sie mehr ist als eine Subtraktion –
 * Stücke dürfen sich überlappen (denselben Ausschnitt zweimal zu zeigen ist
 * eine erlaubte Absicht) und stehen nicht zwingend in zeitlicher Reihenfolge,
 * denn die Reihenfolge im FILM ist eine andere Frage als die Lage im Video.
 */
export function luecken(stuecke: readonly Stueck[], dauerMs: number): Stueck[] {
  if (dauerMs <= 0) return [];
  const belegt = stuecke
    .map((stueck) => ({
      vonMs: Math.max(0, Math.min(dauerMs, stueck.vonMs)),
      bisMs: Math.max(0, Math.min(dauerMs, Math.max(stueck.vonMs, stueck.bisMs))),
    }))
    .filter((stueck) => stueck.bisMs > stueck.vonMs)
    .sort((a, b) => a.vonMs - b.vonMs);

  const raus: Stueck[] = [];
  let stand = 0;
  for (const stueck of belegt) {
    if (stueck.vonMs > stand) raus.push({ vonMs: stand, bisMs: stueck.vonMs });
    stand = Math.max(stand, stueck.bisMs);
  }
  if (stand < dauerMs) raus.push({ vonMs: stand, bisMs: dauerMs });
  return raus;
}
