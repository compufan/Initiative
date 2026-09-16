import { useEffect, useRef, useState } from 'react';
import { toast } from '../../state/ui.js';
import { loadImageFromBlob } from '../stickers/helpers.js';
import { flaeche2d } from './farbraum.js';
import { KERN_MAX, punktbildBauen, type Punktbild } from './entfaltung.js';
import { entfaltenAufGpu, stuetzen, stuetzenGrenze } from './entfaltungGpu.js';

/**
 * „Unschärfe zurückrechnen“ – die Bedienseite der Entfaltung.
 *
 * # Warum das kein Regler ist, der sofort wirkt
 *
 * Weil es Sekunden dauert und weil es das QUELLBILD ändert, nicht die
 * Darstellung. Alle anderen Regler dieses Editors stehen im Dokument und sind
 * jederzeit zurückzunehmen; eine Entfaltung ist ein Schritt, der das Bild
 * ersetzt. Deshalb: einstellen, ansehen, anwenden – und ein Knopf, der das
 * ursprüngliche Bild zurückholt.
 *
 * # Warum eine Vorschau auf einem Ausschnitt
 *
 * Länge und Winkel der Verwacklung liest man nicht ab, man PROBIERT sie.
 * Jeder Versuch am ganzen Bild kostete Sekunden; auf einem Ausschnitt von 320
 * Punkten ist er sofort da. Nebeneinander steht links das Original – ohne
 * Vergleich sieht jede Entfaltung nach „irgendwie anders“ aus.
 *
 * # Was hier ehrlich dabeistehen muss
 *
 * Entfaltet wird NICHT BLIND: Die Unschärfe gibt der Anwender an. Das ist
 * erstens ehrlicher (er sieht den Streifen ja) und zweitens patentfrei – die
 * blinde Kernschätzung aus Gradientenstatistik ist belastet. Und: Wo die
 * Bewegung eine Kante über fünfzig Punkte gezogen hat, ist die Information
 * physikalisch weg. Jedes Verfahren, das dort trotzdem ein scharfes Bild
 * zeigt, hat es ERFUNDEN.
 */

/** Ein Ausschnitt dieser Kante wird für die Vorschau gerechnet. */
const VORSCHAU_KANTE = 320;

export interface EntfaltungsfeldProps {
  bild: HTMLImageElement | null;
  /** Ob gerade ein entfaltetes Bild angezeigt wird. */
  entfaltet: boolean;
  /** Das Ergebnis übernehmen – der Editor tauscht sein Quellbild. */
  onAnwenden: (neu: HTMLImageElement) => void;
  /** Das ursprüngliche Bild zurückholen. */
  onZuruecknehmen: () => void;
}

export function Entfaltungsfeld({
  bild,
  entfaltet,
  onAnwenden,
  onZuruecknehmen,
}: EntfaltungsfeldProps) {
  const [art, setArt] = useState<'linie' | 'scheibe'>('linie');
  const [laenge, setLaenge] = useState(9);
  const [winkel, setWinkel] = useState(0);
  const [radius, setRadius] = useState(3);
  const [durchgaenge, setDurchgaenge] = useState(25);
  const [daempfung, setDaempfung] = useState(0.02);
  const [laeuft, setLaeuft] = useState(false);
  const [anteil, setAnteil] = useState(0);
  const vorherRef = useRef<HTMLCanvasElement | null>(null);
  const nachherRef = useRef<HTMLCanvasElement | null>(null);
  const [offen, setOffen] = useState(false);

  const punktbild: Punktbild =
    art === 'linie' ? { art: 'linie', laenge, winkel } : { art: 'scheibe', radius };
  const kern = punktbildBauen(punktbild);
  const stellen = stuetzen(kern).length;
  const grenze = stuetzenGrenze();
  const zuGross = grenze > 0 && stellen > grenze;

  /*
   * Die Vorschau läuft nach einer kurzen Ruhe, nicht bei jeder Reglerraste.
   *
   * Ein Regler schickt beim Ziehen dutzende Werte. Jeder davon stiesse einen
   * Lauf über den Ausschnitt an, und die Grafikeinheit arbeitete eine
   * Schlange ab, die längst überholt ist – die Vorschau hinkte dem Regler
   * hinterher, statt ihm zu folgen.
   */
  useEffect(() => {
    if (!offen || !bild || grenze === 0 || zuGross) return undefined;
    let weg = false;
    const zeit = setTimeout(() => {
      void (async () => {
        const vorher = vorherRef.current;
        const nachher = nachherRef.current;
        if (!vorher || !nachher) return;
        /*
         * Der Ausschnitt kommt aus der MITTE des Bildes und wird nicht
         * skaliert. Skaliert wäre er wertlos: Die Unschärfe ist in
         * Bildpunkten angegeben, und ein halb so grosser Ausschnitt hätte
         * eine halb so lange Verwacklung.
         */
        const kante = Math.min(VORSCHAU_KANTE, bild.naturalWidth, bild.naturalHeight);
        const sx = Math.floor((bild.naturalWidth - kante) / 2);
        const sy = Math.floor((bild.naturalHeight - kante) / 2);
        vorher.width = kante;
        vorher.height = kante;
        nachher.width = kante;
        nachher.height = kante;
        const ctx = flaeche2d(vorher);
        if (!ctx) return;
        ctx.drawImage(bild, sx, sy, kante, kante, 0, 0, kante, kante);
        const quelle = ctx.getImageData(0, 0, kante, kante);
        try {
          const raus = await entfaltenAufGpu({
            quelle,
            kern,
            iterationen: durchgaenge,
            daempfung,
            saumRadius: Math.max(1, Math.round(kern.breite / 2)),
          });
          if (weg) return;
          flaeche2d(nachher)?.putImageData(raus, 0, 0);
        } catch {
          // Eine Vorschau, die nicht geht, ist keine Meldung wert – beim
          // Anwenden sagt es der Knopf.
        }
      })();
    }, 250);
    return () => {
      weg = true;
      clearTimeout(zeit);
    };
    // `kern` ist bei jedem Rendern ein neues Objekt; die Werte darin sind das,
    // was wirklich zählt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen, bild, art, laenge, winkel, radius, durchgaenge, daempfung, grenze, zuGross]);

  async function anwenden() {
    if (!bild) return;
    setLaeuft(true);
    setAnteil(0);
    try {
      const flaeche = document.createElement('canvas');
      flaeche.width = bild.naturalWidth;
      flaeche.height = bild.naturalHeight;
      const ctx = flaeche2d(flaeche);
      if (!ctx) throw new Error('Keine Zeichenfläche');
      ctx.drawImage(bild, 0, 0);
      const quelle = ctx.getImageData(0, 0, flaeche.width, flaeche.height);
      const raus = await entfaltenAufGpu(
        {
          quelle,
          kern,
          iterationen: durchgaenge,
          daempfung,
          saumRadius: Math.max(1, Math.round(kern.breite / 2)),
        },
        setAnteil,
      );
      ctx.putImageData(raus, 0, 0);
      /*
       * PNG und nicht JPEG: Was hier herauskommt, geht als QUELLE zurück in
       * den Editor und wird danach noch beschnitten, getont und gespeichert.
       * Eine verlustbehaftete Zwischenstufe legte ihre Blöcke unter alles,
       * was danach kommt – und zwar unsichtbar, bis jemand hineinzoomt.
       */
      const blob = await new Promise<Blob | null>((auf) => flaeche.toBlob(auf, 'image/png'));
      if (!blob) throw new Error('Das Bild liess sich nicht ablegen');
      onAnwenden(await loadImageFromBlob(blob));
      toast('Die Unschärfe ist zurückgerechnet.', 'success');
    } catch (fehler) {
      toast(
        fehler instanceof Error ? fehler.message : 'Das Entfalten hat nicht geklappt.',
        'error',
      );
    } finally {
      setLaeuft(false);
      setAnteil(0);
    }
  }

  return (
    <details className="bild-klapp" onToggle={(e) => setOffen(e.currentTarget.open)}>
      <summary>Unschärfe zurückrechnen</summary>

      {grenze === 0 ? (
        <p className="bild-hinweis">
          Dieses Gerät kann nicht entfalten – dafür braucht es WebGL 2 mit Gleitkommazielen. Der
          Regler „Schärfe“ oben wirkt trotzdem.
        </p>
      ) : (
        <>
          <div className="bild-reihe" role="group" aria-label="Art der Unschärfe">
            <button
              type="button"
              className={`btn btn-sm ${art === 'linie' ? 'is-active' : ''}`}
              aria-pressed={art === 'linie'}
              onClick={() => setArt('linie')}
              data-tipp="Die Kamera hat sich bewegt – ein Punkt wird zum Strich"
            >
              Verwackelt
            </button>
            <button
              type="button"
              className={`btn btn-sm ${art === 'scheibe' ? 'is-active' : ''}`}
              aria-pressed={art === 'scheibe'}
              onClick={() => setArt('scheibe')}
              data-tipp="Danebenfokussiert – ein Punkt wird zur Scheibe"
            >
              Unscharf gestellt
            </button>
          </div>

          {art === 'linie' ? (
            <>
              <label className="bild-schieber">
                <span>Länge</span>
                <input
                  type="range"
                  min={2}
                  max={KERN_MAX - 4}
                  step={1}
                  value={laenge}
                  onChange={(e) => setLaenge(Number(e.target.value))}
                />
                <span className="bild-wert">{laenge}</span>
              </label>
              <label className="bild-schieber">
                <span>Richtung</span>
                <input
                  type="range"
                  min={0}
                  max={179}
                  step={1}
                  value={winkel}
                  onChange={(e) => setWinkel(Number(e.target.value))}
                />
                <span className="bild-wert">{winkel}°</span>
              </label>
            </>
          ) : (
            <label className="bild-schieber">
              <span>Radius</span>
              <input
                type="range"
                min={1}
                max={12}
                step={0.5}
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
              />
              <span className="bild-wert">{radius}</span>
            </label>
          )}

          <label className="bild-schieber" data-tipp="Mehr holt mehr zurück – und mehr Rauschen">
            <span>Durchgänge</span>
            <input
              type="range"
              min={5}
              max={60}
              step={1}
              value={durchgaenge}
              onChange={(e) => setDurchgaenge(Number(e.target.value))}
            />
            <span className="bild-wert">{durchgaenge}</span>
          </label>

          <label
            className="bild-schieber"
            data-tipp="Hält glatte Flächen ruhig – dort ist nichts zurückzuholen"
          >
            <span>Rauschbremse</span>
            <input
              type="range"
              min={0}
              max={0.15}
              step={0.005}
              value={daempfung}
              onChange={(e) => setDaempfung(Number(e.target.value))}
            />
            <span className="bild-wert">{Math.round(daempfung * 100)}</span>
          </label>

          <div className="bild-entfaltung-paar">
            <figure>
              <canvas ref={vorherRef} />
              <figcaption>vorher</figcaption>
            </figure>
            <figure>
              <canvas ref={nachherRef} />
              <figcaption>nachher</figcaption>
            </figure>
          </div>

          {zuGross && (
            <p className="bild-hinweis">
              Diese Unschärfe ist für dieses Gerät zu gross ({stellen} Stützstellen, {grenze}{' '}
              gehen). Mit einer kürzeren Länge oder einem kleineren Radius geht es.
            </p>
          )}

          <div className="bild-reihe">
            <button
              type="button"
              className="btn btn-primary"
              disabled={laeuft || !bild || zuGross}
              onClick={() => void anwenden()}
            >
              {laeuft ? `Rechnet … ${Math.round(anteil * 100)} %` : 'Auf das ganze Bild'}
            </button>
            {entfaltet && (
              <button type="button" className="btn" disabled={laeuft} onClick={onZuruecknehmen}>
                Zurücknehmen
              </button>
            )}
          </div>

          <p className="bild-hinweis">
            Die Unschärfe wird nicht geraten, sondern eingestellt – du siehst den Streifen ja. Was
            über fünfzig Punkte verschmiert ist, lässt sich nicht retten: Dort ist die Information
            wirklich weg, und was ein Verfahren dann zeigt, hat es erfunden. Das Ergebnis ersetzt
            das Foto im Editor; „Zurücknehmen“ holt das ursprüngliche zurück.
          </p>
        </>
      )}
    </details>
  );
}
