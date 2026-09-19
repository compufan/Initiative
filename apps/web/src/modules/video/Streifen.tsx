import { useRef } from 'react';

/**
 * Ein Filmstreifen mit zwei Griffen.
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
 */
export function Streifen({
  bilder,
  dauerMs,
  vonMs,
  bisMs,
  gesperrt,
  onBereich,
}: {
  bilder: { zeitMs: number; bild: string }[];
  dauerMs: number;
  vonMs: number;
  bisMs: number;
  gesperrt: boolean;
  onBereich: (vonMs: number, bisMs: number) => void;
}) {
  const bahn = useRef<HTMLDivElement | null>(null);
  const zieht = useRef<'von' | 'bis' | null>(null);

  const zeitAus = (klientX: number): number => {
    const kasten = bahn.current?.getBoundingClientRect();
    if (!kasten || kasten.width === 0) return 0;
    const anteil = Math.min(1, Math.max(0, (klientX - kasten.left) / kasten.width));
    return Math.round(anteil * dauerMs);
  };

  const schieben = (klientX: number) => {
    const zeit = zeitAus(klientX);
    if (zieht.current === 'von') onBereich(Math.min(zeit, bisMs - 100), bisMs);
    else if (zieht.current === 'bis') onBereich(vonMs, Math.max(zeit, vonMs + 100));
  };

  const anteilVon = dauerMs > 0 ? vonMs / dauerMs : 0;
  const anteilBis = dauerMs > 0 ? bisMs / dauerMs : 1;

  return (
    <div
      className={`vg-streifen${gesperrt ? ' ist-aus' : ''}`}
      ref={bahn}
      onPointerMove={(ereignis) => {
        if (zieht.current) schieben(ereignis.clientX);
      }}
      onPointerUp={() => {
        zieht.current = null;
      }}
      onPointerLeave={() => {
        zieht.current = null;
      }}
    >
      {bilder.map((bild) => (
        <img key={bild.zeitMs} src={bild.bild} alt="" aria-hidden="true" />
      ))}
      <div className="vg-schatten" style={{ left: 0, width: `${anteilVon * 100}%` }} />
      <div className="vg-schatten" style={{ left: `${anteilBis * 100}%`, right: 0 }} />
      {(['von', 'bis'] as const).map((welcher) => (
        <button
          key={welcher}
          type="button"
          className="vg-griff"
          style={{ left: `${(welcher === 'von' ? anteilVon : anteilBis) * 100}%` }}
          disabled={gesperrt}
          aria-label={welcher === 'von' ? 'Anfang' : 'Ende'}
          onPointerDown={(ereignis) => {
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
            const schritt = ereignis.shiftKey ? 1000 : 100;
            if (ereignis.key === 'ArrowLeft' || ereignis.key === 'ArrowRight') {
              ereignis.preventDefault();
              const richtung = ereignis.key === 'ArrowLeft' ? -schritt : schritt;
              if (welcher === 'von') {
                onBereich(Math.max(0, Math.min(vonMs + richtung, bisMs - 100)), bisMs);
              } else {
                onBereich(vonMs, Math.min(dauerMs, Math.max(bisMs + richtung, vonMs + 100)));
              }
            }
          }}
        />
      ))}
    </div>
  );
}
