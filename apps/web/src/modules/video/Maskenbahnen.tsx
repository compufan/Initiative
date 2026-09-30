import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  BAHN,
  bahnZustand,
  geltungAbHier,
  geltungBisHier,
  geltungLeer,
  geltungNurAbschnitt,
  griffLage,
  griffZiehen,
  sichtbarAn,
  type Geltung,
  type Griff,
  type Maske,
  type SpurQuelle,
} from './masken.js';
import { bildBereich, bildZuFilm, filmZuBild } from './raster.js';
import { filmAnfangMs, type Abschnitt } from './schnitt.js';
import type { MaskenFortschritt } from './spurdienst.js';

/**
 * Die Masken in der Zeitleiste – wo sie gelten, wo sie zu sehen sind, und
 * wo noch gerechnet wird.
 *
 * # Was eine Bahn zeigt
 *
 * Die Bitte war: „Beides sollte jederzeit in der Zeitleiste angezeigt werden
 * – die Maske ist also überall dort schon in der Zeitleiste sichtbar, wo sie
 * sichtbar ist." Jede Bahn liegt deshalb unter den Abschnitten, im selben
 * Massstab, und zeigt je Bildpunktspalte, was die Verfolgung weiss:
 *
 * - kräftig: Die Maske ist dort zu sehen.
 * - gestreift: erst grob verfolgt (oder ein älterer Stand).
 * - eine dünne Linie: Sie gilt dort, aber der Gegenstand ist nicht im Bild –
 *   er ist hinausgelaufen, oder aus dem Zuschnitt des Abschnitts.
 * - rot schraffiert: Die Verfolgung hat ihn verloren; dort neu antippen.
 * - grau schraffiert: Das wird gerade noch gerechnet.
 * - ◆: dort wurde die Maske eingestellt.
 *
 * # Warum so schmal
 *
 * Auf einem Telefon ist die Höhe knapp: Kopf, Bild, Zeitleiste, Werkzeuge.
 * Bis zu zwei Masken bekommen je eine eigene schmale Bahn, ab drei teilen
 * sie sich EINE Sammelbahn (je Maske ein Streifen). Die gewählte Maske wird
 * aufgeklappt – mit Griffen für ihren Zeitraum –, und die Knopfzeile der
 * Zeitleiste wird dann zur Zeile ihrer Einstellungen, statt eine zweite
 * darunterzulegen.
 */

export interface MaskenLeiste {
  readonly masken: readonly Maske[];
  readonly gewaehlt: string | null;
  readonly quelle: SpurQuelle;
  /** Steigt, wenn die Verfolgung etwas Neues weiss. */
  readonly version: number;
  readonly jeMaske: ReadonlyMap<string, MaskenFortschritt>;
  /** Die Rechengrösse – ohne sie gibt es nichts zu zeichnen. */
  readonly mass: { readonly b: number; readonly h: number } | null;
  /** Im Blatt: nur ansehen, nichts wählen. */
  readonly lesend?: boolean;
  readonly zurueckMoeglich?: boolean;
  onWaehlen(id: string | null): void;
  onGeltung(id: string, geltung: Geltung, fertig: boolean): boolean;
  onAn(id: string, aktiv: boolean): void;
  onLoeschen(id: string): void;
  onTrennen(id: string, filmMs: number): void;
  onZurueck(): void;
  /**
   * Der Griff eines Zeitraums wird gezogen – das Video soll ihm folgen.
   * `fertig` beim Loslassen, wie bei der Wiedergabestelle.
   */
  onGriffZug?(filmMs: number, fertig: boolean): void;
}

/** Wie viele Masken je eine eigene Bahn bekommen, bevor sie sich eine teilen. */
const EINZELN_BIS = 2;

/** Die Farbe einer Maske – aus dem Stil, damit hell und dunkel stimmen. */
function farbeVon(element: HTMLElement | null, farbe: number): string {
  const wert = element
    ? getComputedStyle(element)
        .getPropertyValue(`--maske-${farbe % 8}`)
        .trim()
    : '';
  return wert || '#e0a030';
}

/**
 * Eine Bahn in eine Leinwand zeichnen – von links nach rechts je Spalte
 * einen Zustand.
 */
function bahnZeichnen(
  stift: CanvasRenderingContext2D,
  werte: Uint8Array,
  farbe: string,
  y: number,
  hoehe: number,
  dichte: number,
): void {
  const breite = werte.length;
  for (let x = 0; x < breite; x += 1) {
    const wert = werte[x];
    if (wert === BAHN.aus) continue;
    // Der Geltungsbereich als leichter Grund.
    stift.globalAlpha = 0.16;
    stift.fillStyle = farbe;
    stift.fillRect(x, y, 1, hoehe);
    stift.globalAlpha = 1;
    switch (wert) {
      case BAHN.sichtbar:
        stift.fillStyle = farbe;
        stift.fillRect(x, y, 1, hoehe);
        break;
      case BAHN.grob:
      case BAHN.veraltet:
      case BAHN.vorlaeufig:
        stift.fillStyle = farbe;
        stift.globalAlpha = (x + Math.round(y)) % (6 * dichte) < 3 * dichte ? 0.9 : 0.45;
        stift.fillRect(x, y, 1, hoehe);
        stift.globalAlpha = 1;
        break;
      case BAHN.leer:
        stift.fillStyle = farbe;
        stift.fillRect(x, y + hoehe - Math.max(1, dichte), 1, Math.max(1, dichte));
        break;
      case BAHN.verloren:
        stift.fillStyle = x % (4 * dichte) < 2 * dichte ? '#c0392b' : 'rgba(192, 57, 43, 0.35)';
        stift.fillRect(x, y, 1, hoehe);
        break;
      case BAHN.offen:
        stift.fillStyle =
          x % (4 * dichte) < 2 * dichte ? 'rgba(128,128,128,0.55)' : 'rgba(128,128,128,0.2)';
        stift.fillRect(x, y, 1, hoehe);
        break;
      case BAHN.jenseits:
        if (x % (4 * dichte) < dichte) {
          stift.fillStyle = 'rgba(128,128,128,0.6)';
          stift.fillRect(x, y + hoehe / 2, 1, Math.max(1, dichte));
        }
        break;
      default:
        break;
    }
  }
}

/** Wo im Film eine Maske eingestellt wurde – je Anker jede Stelle, an der der Film ihn zeigt. */
function ankerStellen(maske: Maske, abschnitte: readonly Abschnitt[], s: number): number[] {
  const raus: number[] = [];
  const bereiche = abschnitte.map((abschnitt) => bildBereich(abschnitt, s));
  for (const teil of maske.teile) {
    for (const anker of teil.anker) {
      bereiche.forEach((bereich, nummer) => {
        if (anker.k >= bereich.k0 && anker.k < bereich.k1) {
          raus.push(bildZuFilm(abschnitte, nummer, anker.k, s));
        }
      });
    }
  }
  return raus;
}

/** Eine kurze Beschreibung für Bildschirmleser: wo die Maske zu sehen ist. */
function zusammenfassen(werte: Uint8Array, umfangMs: number, gesamtMs: number): string {
  const spalten = werte.length;
  if (spalten === 0) return 'noch nichts';
  const msJe = umfangMs / spalten;
  const laeufe: string[] = [];
  let start: number | null = null;
  let offen = false;
  for (let x = 0; x <= spalten; x += 1) {
    const wert = x < spalten ? werte[x] : BAHN.aus;
    if (wert === BAHN.offen) offen = true;
    const sichtbar = wert === BAHN.sichtbar || wert === BAHN.grob || wert === BAHN.veraltet;
    if (sichtbar && start === null) start = x;
    if (!sichtbar && start !== null) {
      const von = Math.min(gesamtMs, start * msJe);
      const bis = Math.min(gesamtMs, x * msJe);
      if (laeufe.length < 4) laeufe.push(`${zeitKurz(von)} bis ${zeitKurz(bis)}`);
      else if (laeufe.length === 4) laeufe.push('…');
      start = null;
    }
  }
  const teil = laeufe.length > 0 ? `sichtbar ${laeufe.join(', ')}` : 'nirgends sichtbar';
  return offen ? `${teil}; wird noch verfolgt` : teil;
}

function zeitKurz(ms: number): string {
  const sekunden = ms / 1000;
  return `${sekunden.toFixed(1).replace('.', ',')} s`;
}

/** „noch ~0:35" */
export function restText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return `noch ~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Was über eine Maske in einem Satz zu sagen ist – Anteil, Restzeit, Fehler. */
export function maskenStand(fortschritt: MaskenFortschritt | undefined): string {
  if (!fortschritt) return '';
  if (fortschritt.fehler) return fortschritt.fehler;
  if (fortschritt.anteil >= 1) return 'fertig verfolgt';
  const prozent = Math.round(fortschritt.anteil * 100);
  const grob =
    fortschritt.grobAnteil < 1 && fortschritt.grobRestMs > 0
      ? ` · grob ${restText(fortschritt.grobRestMs)}`
      : '';
  const rest = restText(fortschritt.restMs);
  return `${prozent} %${rest ? ` · ${rest}` : ''}${grob}`;
}

export function Maskenbahnen({
  leiste,
  abschnitte,
  s,
  umfangMs,
  gesamtMs,
  onWischen,
}: {
  leiste: MaskenLeiste;
  abschnitte: readonly Abschnitt[];
  /** Der Bildabstand des Films. */
  s: number;
  /** Wie viel Film die ganze Breite zeigt – derselbe Massstab wie die Abschnitte. */
  umfangMs: number;
  gesamtMs: number;
  /** Ein Zug über die Bahnen wischt wie ein Zug über die Abschnitte. */
  onWischen: (filmMs: number, fertig: boolean) => void;
}) {
  const { masken, gewaehlt, quelle, version, mass, lesend } = leiste;
  const gewaehlteMaske = masken.find((maske) => maske.id === gewaehlt) ?? null;
  const rahmen = useRef<HTMLDivElement | null>(null);
  const [breite, setBreite] = useState(0);

  useEffect(() => {
    const element = rahmen.current;
    if (!element) return undefined;
    const messen = () => setBreite(element.clientWidth);
    messen();
    const beobachter = new ResizeObserver(messen);
    beobachter.observe(element);
    return () => beobachter.disconnect();
  }, []);

  const dichte = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const spalten = Math.max(0, Math.round(breite * dichte));

  /*
   * Die Zustände je Maske – neu nur, wenn sich wirklich etwas geändert hat:
   * die Daten der Verfolgung (`version`, höchstens viermal je Sekunde), die
   * Abschnitte, die Maske selbst oder der Massstab. Nie je Bild der
   * Wiedergabe.
   */
  const werte = useMemo(() => {
    const raus = new Map<string, Uint8Array>();
    if (!mass || spalten === 0 || umfangMs <= 0) return raus;
    for (const maske of masken) {
      raus.set(maske.id, bahnZustand(abschnitte, maske, quelle, s, mass, spalten, umfangMs));
    }
    return raus;
    // `version` steht für den Stand der Verfolgung hinter `quelle`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abschnitte, masken, mass, quelle, s, spalten, umfangMs, version]);

  const einzeln = masken.length <= EINZELN_BIS;
  const zeilen: { masken: readonly Maske[]; gewaehlt: boolean }[] = [];
  if (masken.length > 0) {
    if (einzeln || lesend) {
      for (const maske of masken) {
        zeilen.push({ masken: [maske], gewaehlt: !lesend && maske.id === gewaehlt });
      }
    } else {
      zeilen.push({ masken, gewaehlt: false });
      if (gewaehlteMaske) zeilen.push({ masken: [gewaehlteMaske], gewaehlt: true });
    }
  }

  /* ---------- Tippen wählt, Ziehen wischt ---------- */

  const zug = useRef<{ x: number; y: number; zeit: number; wischt: boolean } | null>(null);
  const filmAus = (klientX: number) => {
    const kasten = rahmen.current?.getBoundingClientRect();
    if (!kasten || kasten.width === 0) return 0;
    const a = Math.min(1, Math.max(0, (klientX - kasten.left) / kasten.width));
    return Math.min(gesamtMs, Math.round(a * umfangMs));
  };
  /** Welche Zeile liegt unter diesem Punkt – die nächste, damit auch eine schmale Bahn trifft. */
  const zeileAn = (klientY: number): number => {
    const kinder = rahmen.current?.querySelectorAll<HTMLElement>('.mb-zeile');
    if (!kinder || kinder.length === 0) return -1;
    let beste = 0;
    let abstand = Infinity;
    kinder.forEach((kind, i) => {
      const k = kind.getBoundingClientRect();
      const d = Math.abs(klientY - (k.top + k.height / 2));
      if (d < abstand) {
        abstand = d;
        beste = i;
      }
    });
    return beste;
  };

  if (masken.length === 0) return null;

  return (
    <div
      ref={rahmen}
      className={`mb${lesend ? ' ist-lesend' : ''}`}
      role="group"
      aria-label={`Masken: ${masken.map((maske) => maske.name).join(', ')}`}
      onPointerDown={(ereignis) => {
        if ((ereignis.target as HTMLElement).closest('.mb-griff')) return;
        zug.current = {
          x: ereignis.clientX,
          y: ereignis.clientY,
          zeit: performance.now(),
          wischt: false,
        };
        ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
      }}
      onPointerMove={(ereignis) => {
        const z = zug.current;
        if (!z) return;
        if (!z.wischt && Math.abs(ereignis.clientX - z.x) > 6) z.wischt = true;
        if (z.wischt) onWischen(filmAus(ereignis.clientX), false);
      }}
      onPointerUp={(ereignis) => {
        const z = zug.current;
        zug.current = null;
        if (!z) return;
        if (z.wischt) {
          onWischen(filmAus(ereignis.clientX), true);
          return;
        }
        // Ein Tipp wählt – und bewegt die Wiedergabestelle NICHT: „Ab hier"
        // soll danach noch dort gelten, wo man vorher war.
        if (lesend) return;
        const zeile = zeilen[zeileAn(ereignis.clientY)];
        if (!zeile) return;
        if (zeile.masken.length === 1) leiste.onWaehlen(zeile.masken[0].id);
        else leiste.onWaehlen(gewaehlt ?? masken[0].id);
      }}
      onPointerCancel={() => {
        zug.current = null;
      }}
    >
      {zeilen.map((zeile, nummer) => (
        <Bahnzeile
          key={zeile.gewaehlt ? `g-${zeile.masken[0].id}` : `z-${nummer}`}
          masken={zeile.masken}
          werte={werte}
          gewaehlt={zeile.gewaehlt}
          sammel={zeile.masken.length > 1}
          lesend={Boolean(lesend)}
          spalten={spalten}
          dichte={dichte}
          abschnitte={abschnitte}
          s={s}
          umfangMs={umfangMs}
          gesamtMs={gesamtMs}
          leiste={leiste}
        />
      ))}
    </div>
  );
}

function Bahnzeile({
  masken,
  werte,
  gewaehlt,
  sammel,
  lesend,
  spalten,
  dichte,
  abschnitte,
  s,
  umfangMs,
  gesamtMs,
  leiste,
}: {
  masken: readonly Maske[];
  werte: ReadonlyMap<string, Uint8Array>;
  gewaehlt: boolean;
  sammel: boolean;
  lesend: boolean;
  spalten: number;
  dichte: number;
  abschnitte: readonly Abschnitt[];
  s: number;
  umfangMs: number;
  gesamtMs: number;
  leiste: MaskenLeiste;
}) {
  const leinwand = useRef<HTMLCanvasElement | null>(null);
  const hoehe = lesend ? 8 : gewaehlt ? 18 : sammel ? 12 : 10;

  useEffect(() => {
    const flaeche = leinwand.current;
    if (!flaeche || spalten === 0) return;
    const h = Math.round(hoehe * dichte);
    if (flaeche.width !== spalten) flaeche.width = spalten;
    if (flaeche.height !== h) flaeche.height = h;
    const stift = flaeche.getContext('2d');
    if (!stift) return;
    stift.clearRect(0, 0, spalten, h);
    const streifen = h / masken.length;
    masken.forEach((maske, i) => {
      const w = werte.get(maske.id);
      if (!w) return;
      const farbe = farbeVon(flaeche, maske.farbe);
      stift.globalAlpha = maske.aktiv ? 1 : 0.35;
      bahnZeichnen(stift, w, farbe, i * streifen, streifen, dichte);
      stift.globalAlpha = 1;
    });
    // Die Anker: kleine Rauten, wo eingestellt wurde.
    if (!sammel) {
      const maske = masken[0];
      stift.fillStyle = '#fff';
      stift.strokeStyle = 'rgba(0,0,0,0.6)';
      stift.lineWidth = dichte;
      const r = Math.min(h / 2 - dichte, 4 * dichte);
      for (const filmMs of ankerStellen(maske, abschnitte, s)) {
        const x = (filmMs / umfangMs) * spalten;
        stift.beginPath();
        stift.moveTo(x, h / 2 - r);
        stift.lineTo(x + r, h / 2);
        stift.lineTo(x, h / 2 + r);
        stift.lineTo(x - r, h / 2);
        stift.closePath();
        stift.fill();
        stift.stroke();
      }
    }
  }, [abschnitte, dichte, hoehe, masken, s, sammel, spalten, umfangMs, werte]);

  const maske = masken[0];
  const beschreibung = sammel
    ? `${masken.length} Masken – antippen zum Wählen`
    : zusammenfassen(werte.get(maske.id) ?? new Uint8Array(), umfangMs, gesamtMs);
  const geltungText =
    maske.geltung.art === 'ganz'
      ? 'ganzer Film'
      : maske.geltung.art === 'abschnitte'
        ? 'nur ein Abschnitt'
        : 'Zeitraum';

  return (
    <div
      className={`mb-zeile${gewaehlt ? ' ist-gewaehlt' : ''}${sammel ? ' ist-sammel' : ''}`}
      style={{ height: `${hoehe}px`, ['--mb-farbe' as string]: `var(--maske-${maske.farbe % 8})` }}
      role="group"
      aria-label={sammel ? 'Masken' : `Maske ${maske.name}, ${geltungText}`}
    >
      {!sammel && <span className="mb-streifen" aria-hidden="true" />}
      <canvas ref={leinwand} className="mb-leinwand" role="img" aria-label={beschreibung} />
      {gewaehlt && !lesend && (
        <Griffe maske={maske} abschnitte={abschnitte} s={s} umfangMs={umfangMs} leiste={leiste} />
      )}
    </div>
  );
}

/** Die Griffe des Zeitraums der gewählten Maske. */
function Griffe({
  maske,
  abschnitte,
  s,
  umfangMs,
  leiste,
}: {
  maske: Maske;
  abschnitte: readonly Abschnitt[];
  s: number;
  umfangMs: number;
  leiste: MaskenLeiste;
}) {
  const bezug = { abschnitte, s };
  const griffe = griffLage(maske.geltung, bezug);
  /** Beim Anfassen festgehalten: die Geltung und der Massstab – sonst zöge sich der Griff unter dem Finger weg. */
  const zug = useRef<{
    griff: Griff;
    geltung: Geltung;
    links: number;
    breite: number;
    letzte: Geltung;
    /** Wo das Video zuletzt hingeschickt wurde – dort endet der Zug. */
    filmMs: number;
  } | null>(null);

  const ziehen = (klientX: number) => {
    const z = zug.current;
    if (!z) return;
    const a = Math.min(1, Math.max(0, (klientX - z.links) / z.breite));
    const filmMs = a * umfangMs;
    const neu = griffZiehen(z.geltung, z.griff, filmMs, bezug);
    if (leiste.onGeltung(maske.id, neu, false)) z.letzte = neu;
    z.filmMs = Math.min(filmMs, filmEnde(abschnitte));
    leiste.onGriffZug?.(z.filmMs, false);
  };

  const loslassen = () => {
    const z = zug.current;
    zug.current = null;
    if (!z) return;
    leiste.onGeltung(maske.id, z.letzte, true);
    leiste.onGriffZug?.(z.filmMs, true);
  };

  return (
    <>
      {griffe.map((griff) => {
        const links = `${(griff.filmMs / umfangMs) * 100}%`;
        const name = griff.art === 'anfang' ? 'Anfang' : 'Ende';
        if (!griff.frei) {
          return (
            <span
              key={`${griff.stueck}-${griff.art}`}
              className={`mb-ueber mb-ueber-${griff.art}`}
              style={{ left: links }}
              title="reicht über den Film hinaus"
              aria-label={`${name} des Zeitraums liegt ausserhalb des Films`}
            >
              {griff.art === 'anfang' ? '◂' : '▸'}
            </span>
          );
        }
        return (
          <button
            key={`${griff.stueck}-${griff.art}`}
            type="button"
            className={`mb-griff mb-griff-${griff.art}`}
            style={{ left: links }}
            role="slider"
            aria-label={`${name} des Zeitraums von „${maske.name}"`}
            aria-valuemin={0}
            aria-valuemax={Math.round(umfangMs)}
            aria-valuenow={Math.round(griff.filmMs)}
            aria-valuetext={zeitText(griff.filmMs)}
            onPointerDown={(ereignis) => {
              ereignis.stopPropagation();
              const kasten = ereignis.currentTarget.parentElement?.getBoundingClientRect();
              if (!kasten) return;
              zug.current = {
                griff,
                geltung: maske.geltung,
                links: kasten.left,
                breite: kasten.width,
                letzte: maske.geltung,
                filmMs: griff.filmMs,
              };
              ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
            }}
            onPointerMove={(ereignis) => ziehen(ereignis.clientX)}
            onPointerUp={loslassen}
            onPointerCancel={loslassen}
            onLostPointerCapture={loslassen}
            onKeyDown={(ereignis) => {
              if (ereignis.key !== 'ArrowLeft' && ereignis.key !== 'ArrowRight') return;
              ereignis.preventDefault();
              // Sonst liefe die Wiedergabestelle mit – ihr Tastenhandler sitzt darüber.
              ereignis.stopPropagation();
              const weite = (ereignis.shiftKey ? 10 : 1) * s;
              const richtung = ereignis.key === 'ArrowLeft' ? -1 : 1;
              // Von der Mitte des Randbildes aus – sonst rundete ein Schritt
              // um ein halbes Bild auf dieselbe Kante zurück.
              const mitte = griff.filmMs + (griff.art === 'anfang' ? s / 2 : -s / 2);
              const neu = griffZiehen(maske.geltung, griff, mitte + richtung * weite, bezug);
              leiste.onGeltung(maske.id, neu, true);
            }}
          />
        );
      })}
    </>
  );
}

function filmEnde(abschnitte: readonly Abschnitt[]): number {
  return filmAnfangMs(abschnitte, abschnitte.length);
}

/**
 * Die Zeile der Einstellungen für die gewählte Maske – sie ersetzt die
 * Knopfzeile der Zeitleiste, solange eine Maske gewählt ist.
 */
export function MaskenChips({
  leiste,
  abschnitte,
  s,
  spielkopfMs,
  onZurStelle,
  vorne,
}: {
  leiste: MaskenLeiste;
  abschnitte: readonly Abschnitt[];
  s: number;
  spielkopfMs: number;
  onZurStelle: (filmMs: number) => void;
  /** Was vor den Einstellungen stehen bleibt – der Abspielknopf. */
  vorne?: ReactNode;
}) {
  const maske = leiste.masken.find((eintrag) => eintrag.id === leiste.gewaehlt);
  if (!maske) return null;
  const bezug = { abschnitte, s };
  const hier = filmZuBild(abschnitte, spielkopfMs, s);
  const abschnittHier = hier ? abschnitte[hier.nummer] : undefined;
  const g = maske.geltung;
  const ganz = g.art === 'ganz';
  const nurHier =
    g.art === 'abschnitte' &&
    abschnittHier !== undefined &&
    g.ids.length === 1 &&
    g.ids[0] === abschnittHier.id;
  const setzen = (neu: Geltung) => leiste.onGeltung(maske.id, neu, true);
  const stand = maskenStand(leiste.jeMaske.get(maske.id));
  const leer = geltungLeer(g, bezug);

  /** Die nächste Stelle im Film, an der die Maske zu sehen ist. */
  const zurMaske = () => {
    if (!leiste.mass) return;
    const rahmenWerte = { abschnitte, s, b: leiste.mass.b, h: leiste.mass.h };
    let beste: number | null = null;
    abschnitte.forEach((abschnitt, nummer) => {
      const { k0, k1 } = bildBereich(abschnitt, s);
      for (let k = k0; k < k1; k += 1) {
        if (sichtbarAn(maske, k, abschnitt.doc, leiste.quelle, rahmenWerte)) {
          const filmMs = bildZuFilm(abschnitte, nummer, k, s);
          if (beste === null || Math.abs(filmMs - spielkopfMs) < Math.abs(beste - spielkopfMs)) {
            beste = filmMs;
          }
        }
      }
    });
    if (beste === null) {
      // Noch nirgends zu sehen: dorthin, wo sie eingestellt wurde.
      const anker = ankerStellen(maske, abschnitte, s);
      if (anker.length > 0) beste = anker[0];
    }
    if (beste !== null) onZurStelle(beste);
  };

  return (
    <>
      <div className="zl-leiste mb-chips" role="toolbar" aria-label={`Maske ${maske.name}`}>
        {vorne}
        <span
          className="mb-name"
          style={{ ['--mb-farbe' as string]: `var(--maske-${maske.farbe % 8})` }}
        >
          <span className="mb-punkt" aria-hidden="true" />
          {maske.name}
          {stand && <span className="mb-stand"> · {stand}</span>}
        </span>
        <div className="mb-wahl" role="radiogroup" aria-label="Wo die Maske gilt">
          <button
            type="button"
            role="radio"
            aria-checked={ganz}
            className={`btn btn-sm${ganz ? ' is-active' : ''}`}
            onClick={() => setzen({ art: 'ganz' })}
          >
            Ganzer Film
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!ganz}
            className={`btn btn-sm${!ganz ? ' is-active' : ''}`}
            onClick={() => {
              if (!ganz) return;
              if (maske.zuletzt) setzen(maske.zuletzt);
              else if (abschnittHier) setzen(geltungNurAbschnitt(abschnittHier.id));
            }}
          >
            Zeitraum
          </button>
        </div>
        {abschnitte.length > 1 && abschnittHier && hier && (
          <button
            type="button"
            className={`btn btn-sm${nurHier ? ' is-active' : ''}`}
            aria-pressed={nurHier}
            onClick={() => setzen(geltungNurAbschnitt(abschnittHier.id))}
          >
            Nur Abschnitt {hier.nummer + 1}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setzen(geltungAbHier(g, bezug, spielkopfMs))}
          title="Die Maske gilt ab der Wiedergabestelle"
        >
          Ab hier
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setzen(geltungBisHier(g, bezug, spielkopfMs))}
          title="Die Maske gilt bis zur Wiedergabestelle"
        >
          Bis hier
        </button>
        <button type="button" className="btn btn-sm" onClick={zurMaske}>
          Zur Maske
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={maske.aktiv}
          onClick={() => leiste.onAn(maske.id, !maske.aktiv)}
          title={maske.aktiv ? 'Maske ausschalten' : 'Maske einschalten'}
          aria-label={maske.aktiv ? `„${maske.name}" ausschalten` : `„${maske.name}" einschalten`}
        >
          {maske.aktiv ? '👁' : '🚫'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => leiste.onTrennen(maske.id, spielkopfMs)}
          title="Zwei Masken daraus machen, getrennt an der Wiedergabestelle – dann lassen sie sich verschieden einstellen"
        >
          Hier trennen
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => leiste.onLoeschen(maske.id)}
          aria-label={`Maske „${maske.name}" löschen`}
        >
          🗑
        </button>
        {leiste.zurueckMoeglich && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={leiste.onZurueck}
            aria-label="Letzte Änderung an den Masken zurücknehmen"
          >
            ↺
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => leiste.onWaehlen(null)}
        >
          Fertig
        </button>
      </div>
      {leer && (
        <p className="mb-hinweis" role="status">
          Der Abschnitt dieser Maske ist nicht mehr im Film – sie wirkt nirgends.
        </p>
      )}
    </>
  );
}

/** Dieselbe Zeitangabe wie in der Zeitleiste – hier nachgebaut, um keinen Kreis zu schliessen. */
function zeitText(ms: number): string {
  const gesamt = Math.max(0, ms);
  const minuten = Math.floor(gesamt / 60_000);
  const sekunden = Math.floor((gesamt % 60_000) / 1000);
  const hundertstel = Math.floor((gesamt % 1000) / 10);
  return `${minuten}:${String(sekunden).padStart(2, '0')},${String(hundertstel).padStart(2, '0')}`;
}
