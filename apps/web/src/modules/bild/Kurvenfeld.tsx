import { useEffect, useRef, useState } from 'react';

import { KURVE_STUETZEN, kurveTabelle, type Kurvenpunkt } from './fein.js';

/**
 * Das Kurvenfeld – der Regler, der keiner ist.
 *
 * # Warum eine Kurve und nicht noch drei Schieber
 *
 * „Lichter“, „Tiefen“ und „Kontrast“ sind feste Kurven mit einem Regler für
 * ihre Stärke. Sie decken das ab, was man meistens will, und genau das ist
 * ihre Grenze: Wer die Tiefen anheben will, ohne das Schwarz zu verlieren,
 * oder einen Verlauf nur im oberen Drittel abflachen, hat dafür keinen
 * Regler. Mit einer Kurve hat er ihn – und zwar für jede Form, die ihm
 * einfällt.
 *
 * # Warum es hier so wenig gibt
 *
 * Kein Histogramm im Hintergrund, keine Pipette, keine Vorlagen. Das sind
 * Dinge, die ein Kurvenfeld schöner machen, und keines davon ändert etwas am
 * Bild. Was es gibt, ist das, woran die Kurve hängt: Punkte setzen, Punkte
 * ziehen, Punkte wegnehmen.
 *
 * # Die Umrechnung, an der man sich verrechnet
 *
 * Eine Leinwand zählt von OBEN, eine Kurve von unten. Jeder Weg zwischen
 * Bildpunkten und Kurvenwerten dreht deshalb die senkrechte Achse um, und
 * zwar an genau zwei Stellen (`zuFeld`, `zuKurve`). Wer eine davon vergisst,
 * bekommt eine Kurve, die sich beim Ziehen in die falsche Richtung bewegt –
 * und das sieht nach einem Vorzeichenfehler in der Farbrechnung aus, nicht
 * nach einem in der Anzeige.
 */

/** Wie nah ein Tipp an einem Punkt sein muss, um ihn zu greifen – in Punkten. */
const GREIFWEITE = 18;

/** Wieviele Punkte eine Kurve höchstens trägt. */
const PUNKTE_MAX = 16;

interface KurvenfeldProps {
  punkte: readonly Kurvenpunkt[];
  onAendern: (punkte: Kurvenpunkt[]) => void;
  /** Wird vor der ersten Änderung eines Zuges gerufen – für „Rückgängig“. */
  onBeginn?: () => void;
  /** Die Farbe der Linie. Für die Kanalkurven rot, grün, blau. */
  farbe?: string;
  label: string;
}

/** Die Punkte, mit denen gerechnet wird – immer mit beiden Enden. */
function mitEnden(punkte: readonly Kurvenpunkt[]): Kurvenpunkt[] {
  const sortiert = [...punkte].sort((a, b) => a.x - b.x);
  if (sortiert.length === 0 || sortiert[0].x > 0) sortiert.unshift({ x: 0, y: 0 });
  if (sortiert[sortiert.length - 1].x < 1) sortiert.push({ x: 1, y: 1 });
  return sortiert;
}

export function Kurvenfeld({
  punkte,
  onAendern,
  onBeginn,
  farbe = 'currentColor',
  label,
}: KurvenfeldProps) {
  const leinwand = useRef<HTMLCanvasElement | null>(null);
  const [gezogen, setGezogen] = useState<number | null>(null);
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const arbeit = mitEnden(punkte);

  useEffect(() => {
    const flaeche = leinwand.current;
    if (!flaeche) return;
    const ctx = flaeche.getContext('2d');
    if (!ctx) return;

    /*
     * Auf die GERÄTEauflösung zeichnen, nicht auf die CSS-Grösse.
     *
     * Ohne das ist eine Kurvenlinie auf einem Telefon mit dreifacher Dichte
     * drei Bildpunkte breit und sichtbar ausgefranst – und das ist die
     * einzige Linie im ganzen Editor, an der man eine Form ablesen soll.
     */
    const dichte = Math.min(3, window.devicePixelRatio || 1);
    const breite = flaeche.clientWidth || 240;
    const hoehe = flaeche.clientHeight || 240;
    if (flaeche.width !== Math.round(breite * dichte)) {
      flaeche.width = Math.round(breite * dichte);
      flaeche.height = Math.round(hoehe * dichte);
    }
    ctx.setTransform(dichte, 0, 0, dichte, 0, 0);
    ctx.clearRect(0, 0, breite, hoehe);

    const stil = getComputedStyle(flaeche);
    const linie = stil.getPropertyValue('--bild-kurve-gitter').trim() || 'rgba(128,128,128,0.35)';

    // Das Gitter: Drittel, nicht Viertel – Schatten, Mitten, Lichter.
    ctx.strokeStyle = linie;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i += 1) {
      const t = (i / 4) * breite;
      ctx.moveTo(t, 0);
      ctx.lineTo(t, hoehe);
      const u = (i / 4) * hoehe;
      ctx.moveTo(0, u);
      ctx.lineTo(breite, u);
    }
    ctx.stroke();

    // Die Diagonale: „nichts tun“ als Bezug, gestrichelt.
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, hoehe);
    ctx.lineTo(breite, 0);
    ctx.stroke();
    ctx.restore();

    /*
     * Gezeichnet wird die TABELLE, nicht eine eigene Interpolation.
     *
     * Sonst zeigte das Feld eine Kurve und das Bild eine andere – und der
     * Unterschied wäre genau an den Stellen am grössten, an denen man hinsieht
     * (nahe den Stützpunkten). Es ist dieselbe Funktion, die auch der
     * Schattierer füttert.
     */
    const tabelle = kurveTabelle(arbeit);
    ctx.strokeStyle = farbe;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < KURVE_STUETZEN; i += 1) {
      const x = (i / (KURVE_STUETZEN - 1)) * breite;
      const y = (1 - tabelle[i]) * hoehe;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Die Griffe.
    for (let i = 0; i < arbeit.length; i += 1) {
      const p = arbeit[i];
      ctx.beginPath();
      ctx.arc(p.x * breite, (1 - p.y) * hoehe, i === gewaehlt ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === gewaehlt ? farbe : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = farbe;
      ctx.stroke();
    }
  }, [arbeit, farbe, gewaehlt]);

  function zuKurve(event: React.PointerEvent<HTMLCanvasElement>): Kurvenpunkt {
    const kasten = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - kasten.left) / Math.max(1, kasten.width);
    // Die senkrechte Achse dreht sich: Eine Leinwand zählt von oben.
    const y = 1 - (event.clientY - kasten.top) / Math.max(1, kasten.height);
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function treffer(event: React.PointerEvent<HTMLCanvasElement>): number | null {
    const kasten = event.currentTarget.getBoundingClientRect();
    let beste: number | null = null;
    let abstand = GREIFWEITE;
    for (let i = 0; i < arbeit.length; i += 1) {
      const px = kasten.left + arbeit[i].x * kasten.width;
      const py = kasten.top + (1 - arbeit[i].y) * kasten.height;
      const d = Math.hypot(event.clientX - px, event.clientY - py);
      if (d <= abstand) {
        abstand = d;
        beste = i;
      }
    }
    return beste;
  }

  function setzen(index: number, punkt: Kurvenpunkt) {
    const neu = arbeit.map((p, i) => (i === index ? punkt : p));
    /*
     * Die beiden Enden bleiben an ihrem x.
     *
     * Nicht aus Prinzip, sondern weil eine Kurve, deren erster Punkt bei 0,3
     * anfängt, für alles darunter nicht definiert wäre – und „nicht
     * definiert“ heisst in der Auswertung „irgendetwas“. Die HÖHE der Enden
     * ist frei: Genau damit hebt man den Schwarzpunkt an.
     */
    if (index === 0) neu[0] = { x: 0, y: punkt.y };
    if (index === arbeit.length - 1) neu[index] = { x: 1, y: punkt.y };
    onAendern(neu);
  }

  function runter(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const getroffen = treffer(event);
    onBeginn?.();
    if (getroffen !== null) {
      setGezogen(getroffen);
      setGewaehlt(getroffen);
      return;
    }
    if (arbeit.length >= PUNKTE_MAX) return;
    const neu = zuKurve(event);
    const liste = [...arbeit, neu].sort((a, b) => a.x - b.x);
    const index = liste.indexOf(neu);
    setGezogen(index);
    setGewaehlt(index);
    onAendern(liste);
  }

  function bewegen(event: React.PointerEvent<HTMLCanvasElement>) {
    if (gezogen === null) return;
    event.preventDefault();
    setzen(gezogen, zuKurve(event));
  }

  function loslassen() {
    setGezogen(null);
  }

  function entfernen() {
    if (gewaehlt === null) return;
    // Die Enden bleiben: Ohne sie wäre die Kurve an den Rändern offen.
    if (gewaehlt === 0 || gewaehlt === arbeit.length - 1) return;
    onBeginn?.();
    onAendern(arbeit.filter((_, i) => i !== gewaehlt));
    setGewaehlt(null);
  }

  const innen = gewaehlt !== null && gewaehlt > 0 && gewaehlt < arbeit.length - 1;

  return (
    <div className="bild-kurve">
      <canvas
        ref={leinwand}
        className="bild-kurve-feld"
        aria-label={label}
        onPointerDown={runter}
        onPointerMove={bewegen}
        onPointerUp={loslassen}
        onPointerCancel={loslassen}
      />
      <div className="bild-reihe">
        <button
          type="button"
          className="btn btn-sm"
          onClick={entfernen}
          disabled={!innen}
          data-tipp="Den gewählten Punkt aus der Kurve nehmen"
        >
          Punkt entfernen
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onBeginn?.();
            onAendern([]);
            setGewaehlt(null);
          }}
          disabled={punkte.length === 0}
          data-tipp="Die Kurve wieder gerade ziehen"
        >
          Gerade
        </button>
      </div>
    </div>
  );
}
