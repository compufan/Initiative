import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { wirksamerZuschnitt } from '../bild/doc.js';
import {
  BAHN,
  bahnZustand,
  geltungAbHier,
  geltungBisHier,
  geltungLeer,
  geltungNurAbschnitt,
  griffLage,
  griffZiehen,
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
 * sie sich EINE Sammelbahn (je Maske ein Streifen). Ein Tipp darauf zeigt
 * die Namen zur Wahl. Die gewählte Maske wird aufgeklappt – mit Griffen für
 * ihren Zeitraum –, und die Knopfzeile der Zeitleiste wird dann zur Zeile
 * ihrer Einstellungen, statt eine zweite darunterzulegen.
 *
 * # Warum hier so viel gemerkt wird
 *
 * Die Zeitleiste rendert bei jedem Bild der Wiedergabe neu, und der Editor
 * meldet jeden Reglerschritt. Gerechnet (`bahnZustand`, je Maske über alle
 * Bilder des Films) wird nur, wenn sich an einer Maske Teile oder Geltung
 * ändern, an den Abschnitten Grenzen oder Zuschnitt, oder wenn die
 * Verfolgung Neues meldet. Gezeichnet nur, wenn sich das Ergebnis ändert.
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
   * Einen weiteren Bereich anlegen – die Namenswahl bekommt dann „＋ Bereich".
   * Fehlt es, gibt es den Knopf nicht (der Editor könnte ihn nicht erfüllen).
   */
  onNeu?(): void;
  /** ↺ bleibt, solange der Finger oder der Fokus darauf liegt – sonst verschwände er unter der Hand. */
  onZurueckHalten?(an: boolean): void;
  /**
   * Der Griff eines Zeitraums wird gezogen – das Video soll ihm folgen.
   * `fertig` beim Loslassen, wie bei der Wiedergabestelle. `filmMs` ist die
   * Mitte des Randbildes INNERHALB des Zeitraums: dort, wo man sieht, wie
   * die Maske anfängt oder aufhört.
   */
  onGriffZug?(filmMs: number, fertig: boolean): void;
}

/** Was die Bahnen zuletzt gerechnet haben – „Zur Maske" liest darin, statt neu zu rechnen. */
export interface BahnWerte {
  readonly werte: ReadonlyMap<string, Uint8Array>;
  readonly umfangMs: number;
}

/** Wie viele Masken je eine eigene Bahn bekommen, bevor sie sich eine teilen. */
const EINZELN_BIS = 2;

/** Die Zustände, in denen eine Maske zu sehen ist. */
function zuSehen(wert: number): boolean {
  return wert >= BAHN.veraltet && wert <= BAHN.sichtbar;
}

/**
 * Das Farbschema der Seite – die Farben der Bahnen hängen daran, und eine
 * Leinwand zeichnet sich bei einem Wechsel nicht von selbst neu.
 */
function useThema(): string {
  const lesen = () =>
    typeof document === 'undefined' ? '' : (document.documentElement.dataset.theme ?? '');
  const [thema, setThema] = useState(lesen);
  useEffect(() => {
    const beobachter = new MutationObserver(() => setThema(lesen()));
    beobachter.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => beobachter.disconnect();
  }, []);
  return thema;
}

/** Die Farben aller Masken aus dem Stil – einmal je Farbschema, nicht je Zeichnung. */
function farbenLesen(element: HTMLElement): string[] {
  const stil = getComputedStyle(element);
  return Array.from(
    { length: 8 },
    (_, i) => stil.getPropertyValue(`--maske-${i}`).trim() || '#e0a030',
  );
}

/**
 * Die Abschnitte, wie die Bahnen sie brauchen: dieselbe Liste, solange sich
 * weder Grenzen noch Zuschnitt ändern.
 *
 * Jeder Reglerschritt im Editor ersetzt das Dokument eines Abschnitts und
 * damit die Liste – für die Bahnen zählt davon nur der Zuschnitt (ein
 * Gegenstand ausserhalb ist nicht zu sehen).
 */
function useBahnAbschnitte(
  abschnitte: readonly Abschnitt[],
  mass: { readonly b: number; readonly h: number } | null,
): readonly Abschnitt[] {
  const schluessel = abschnitte
    .map((abschnitt) => {
      const z = mass && abschnitt.doc ? wirksamerZuschnitt(abschnitt.doc, mass.b, mass.h) : null;
      return `${abschnitt.id}:${abschnitt.vonMs}:${abschnitt.bisMs}:${
        z ? `${z.x},${z.y},${z.w},${z.h}` : '-'
      }`;
    })
    .join('|');
  const merk = useRef({ schluessel, abschnitte });
  if (merk.current.schluessel !== schluessel) merk.current = { schluessel, abschnitte };
  return merk.current.abschnitte;
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

interface Zeile {
  readonly masken: readonly Maske[];
  readonly gewaehlt: boolean;
}

export function Maskenbahnen({
  leiste,
  abschnitte,
  s,
  umfangMs,
  gesamtMs,
  gesperrt = false,
  onWischen,
  onSammelTipp,
  bahnWerte,
}: {
  leiste: MaskenLeiste;
  abschnitte: readonly Abschnitt[];
  /** Der Bildabstand des Films. */
  s: number;
  /** Wie viel Film die ganze Breite zeigt – derselbe Massstab wie die Abschnitte. */
  umfangMs: number;
  gesamtMs: number;
  /** Wie die übrige Zeitleiste: kein Wischen, kein Wählen – etwa während der Film gebaut wird. */
  gesperrt?: boolean;
  /** Ein Zug über die Bahnen wischt wie ein Zug über die Abschnitte. */
  onWischen: (filmMs: number, fertig: boolean) => void;
  /** Ein Tipp auf die Sammelbahn – die Namen der Masken zur Wahl zeigen. */
  onSammelTipp?: () => void;
  /** Hier legen die Bahnen ab, was sie gerechnet haben (für „Zur Maske"). */
  bahnWerte?: RefObject<BahnWerte | null>;
}) {
  const { masken, gewaehlt, quelle, version, mass, lesend } = leiste;
  const rahmen = useRef<HTMLDivElement | null>(null);
  const [breite, setBreite] = useState(0);
  const thema = useThema();

  /*
   * Gemessen wird, sobald es den Rahmen gibt – und den gibt es erst mit der
   * ersten Maske. An `[]` gehängt, lief die Messung beim Einhängen der
   * leeren Zeitleiste, fand nichts und kam nie wieder: Die Bahn blieb null
   * Punkte breit.
   */
  const hatMasken = masken.length > 0;
  useEffect(() => {
    const element = rahmen.current;
    if (!element) return undefined;
    const messen = () => setBreite(element.clientWidth);
    messen();
    const beobachter = new ResizeObserver(messen);
    beobachter.observe(element);
    return () => beobachter.disconnect();
  }, [hatMasken]);

  const dichte = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const spalten = Math.max(0, Math.round(breite * dichte));
  const bahnAbschnitte = useBahnAbschnitte(abschnitte, mass);

  /*
   * Die Zustände je Maske – neu nur für eine Maske, deren Teile oder
   * Geltung sich geändert haben, und für alle, wenn sich der Rahmen ändert:
   * Abschnitte (Grenzen, Zuschnitt), Massstab, oder die Verfolgung meldet
   * Neues (`version`, höchstens viermal je Sekunde). Ein Regler an einer
   * Maske ändert nur ihre Einstellungen – dafür wird nichts gerechnet.
   */
  const kontext = useMemo(
    () => ({}),
    // `version` steht für den Stand der Verfolgung hinter `quelle`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bahnAbschnitte, mass, quelle, s, spalten, umfangMs, version],
  );
  const gerechnet = useRef(
    new Map<string, { kontext: object; teile: unknown; geltung: unknown; werte: Uint8Array }>(),
  );
  const werte = useMemo(() => {
    const raus = new Map<string, Uint8Array>();
    if (!mass || spalten === 0 || umfangMs <= 0) return raus;
    const alt = gerechnet.current;
    const neu = new Map<
      string,
      { kontext: object; teile: unknown; geltung: unknown; werte: Uint8Array }
    >();
    for (const maske of masken) {
      const vorher = alt.get(maske.id);
      const eintrag =
        vorher &&
        vorher.kontext === kontext &&
        vorher.teile === maske.teile &&
        vorher.geltung === maske.geltung
          ? vorher
          : {
              kontext,
              teile: maske.teile,
              geltung: maske.geltung,
              werte: bahnZustand(bahnAbschnitte, maske, quelle, s, mass, spalten, umfangMs),
            };
      neu.set(maske.id, eintrag);
      raus.set(maske.id, eintrag.werte);
    }
    gerechnet.current = neu;
    return raus;
  }, [bahnAbschnitte, kontext, mass, masken, quelle, s, spalten, umfangMs]);

  useEffect(() => {
    if (bahnWerte) (bahnWerte as { current: BahnWerte | null }).current = { werte, umfangMs };
  }, [bahnWerte, umfangMs, werte]);

  const einzeln = masken.length <= EINZELN_BIS;
  const zeilen = useMemo(() => {
    const raus: Zeile[] = [];
    if (masken.length === 0) return raus;
    if (einzeln || lesend) {
      for (const maske of masken) {
        raus.push({ masken: [maske], gewaehlt: !lesend && maske.id === gewaehlt });
      }
    } else {
      raus.push({ masken, gewaehlt: false });
      const gewaehlteMaske = masken.find((maske) => maske.id === gewaehlt);
      if (gewaehlteMaske) raus.push({ masken: [gewaehlteMaske], gewaehlt: true });
    }
    return raus;
  }, [einzeln, gewaehlt, lesend, masken]);

  /* ---------- Tippen wählt, Ziehen wischt ---------- */

  const zug = useRef<{ x: number; wischt: boolean; letzte: number } | null>(null);
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
  /*
   * Der Zug endet auch ohne Loslassen: bei einem Abbruch durch das System
   * und wenn die Bindung verloren geht – etwa beim ersten Öffnen des
   * Editors, wenn die Zeitleiste umgehängt wird (wie `verloren` in
   * `Zeitleiste.tsx`). Sonst bliebe die Wiedergabe über dem Editor liegen
   * und die Verfolgung ruhte, bis jemand zufällig die Leiste bedient.
   */
  const abbrechen = () => {
    const z = zug.current;
    zug.current = null;
    if (z?.wischt) onWischen(z.letzte, true);
  };

  if (masken.length === 0) return null;

  return (
    <div
      ref={rahmen}
      className={`mb${lesend ? ' ist-lesend' : ''}${gesperrt ? ' ist-aus' : ''}`}
      role="group"
      aria-label={`Masken: ${masken.map((maske) => maske.name).join(', ')}`}
      onPointerDown={(ereignis) => {
        if (gesperrt || (ereignis.target as HTMLElement).closest('.mb-griff')) return;
        zug.current = { x: ereignis.clientX, wischt: false, letzte: filmAus(ereignis.clientX) };
        ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
      }}
      onPointerMove={(ereignis) => {
        const z = zug.current;
        if (!z) return;
        if (!z.wischt && Math.abs(ereignis.clientX - z.x) > 6) z.wischt = true;
        if (!z.wischt) return;
        z.letzte = filmAus(ereignis.clientX);
        onWischen(z.letzte, false);
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
        // Drei Punkte hohe Streifen trifft kein Finger – die Namen zur Wahl.
        else onSammelTipp?.();
      }}
      onPointerCancel={abbrechen}
      onLostPointerCapture={abbrechen}
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
          thema={thema}
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
  thema,
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
  thema: string;
  abschnitte: readonly Abschnitt[];
  s: number;
  umfangMs: number;
  gesamtMs: number;
  leiste: MaskenLeiste;
}) {
  const leinwand = useRef<HTMLCanvasElement | null>(null);
  const hoehe = lesend ? 8 : gewaehlt ? 18 : sammel ? 12 : 10;
  const farben = useRef<{ thema: string; liste: string[] } | null>(null);
  /** Was zuletzt gezeichnet wurde – gleich, dann bleibt die Leinwand, wie sie ist. */
  const gezeichnet = useRef<readonly unknown[] | null>(null);
  const anker = sammel ? '' : ankerStellen(masken[0], abschnitte, s).join(',');

  /*
   * Läuft bei jedem Rendern (also bei jedem Bild der Wiedergabe), zeichnet
   * aber nur, wenn sich etwas geändert hat: ein Vergleich weniger Werte
   * statt tausend Spalten.
   */
  useEffect(() => {
    const flaeche = leinwand.current;
    if (!flaeche || spalten === 0) return;
    const h = Math.round(hoehe * dichte);
    const zeichen: unknown[] = [spalten, h, thema, umfangMs, anker];
    for (const maske of masken) zeichen.push(werte.get(maske.id), maske.farbe, maske.aktiv);
    const vorher = gezeichnet.current;
    if (vorher && vorher.length === zeichen.length && vorher.every((w, i) => w === zeichen[i])) {
      return;
    }
    gezeichnet.current = zeichen;
    if (farben.current?.thema !== thema) {
      farben.current = { thema, liste: farbenLesen(flaeche) };
    }
    const liste = farben.current.liste;
    if (flaeche.width !== spalten) flaeche.width = spalten;
    if (flaeche.height !== h) flaeche.height = h;
    const stift = flaeche.getContext('2d');
    if (!stift) return;
    stift.clearRect(0, 0, spalten, h);
    const streifen = h / masken.length;
    masken.forEach((maske, i) => {
      const w = werte.get(maske.id);
      if (!w) return;
      stift.globalAlpha = maske.aktiv ? 1 : 0.35;
      bahnZeichnen(stift, w, liste[maske.farbe % 8], i * streifen, streifen, dichte);
      stift.globalAlpha = 1;
    });
    // Die Anker: kleine Rauten, wo eingestellt wurde.
    if (anker) {
      stift.fillStyle = '#fff';
      stift.strokeStyle = 'rgba(0,0,0,0.6)';
      stift.lineWidth = dichte;
      const r = Math.min(h / 2 - dichte, 4 * dichte);
      for (const filmMs of anker.split(',').map(Number)) {
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
  });

  const maske = masken[0];
  const beschreibung = sammel
    ? `${masken.length} Masken – antippen, um eine zu wählen`
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
    bewegt: boolean;
    weg: () => void;
  } | null>(null);

  /**
   * Die Mitte des Randbildes INNERHALB des Zeitraums, nachdem der Griff dort
   * eingerastet ist – nicht die Stelle des Fingers. Der Griff bleibt an der
   * Kante seines Abschnitts stehen, der Finger nicht; und das Randbild
   * AUSSERHALB zeigte gerade keine Maske.
   */
  const griffStelle = (neu: Geltung, griff: Griff, fingerMs: number): number => {
    let beste: Griff | null = null;
    for (const kandidat of griffLage(neu, bezug)) {
      if (!kandidat.frei || kandidat.art !== griff.art || kandidat.nummer !== griff.nummer)
        continue;
      if (!beste || Math.abs(kandidat.filmMs - fingerMs) < Math.abs(beste.filmMs - fingerMs)) {
        beste = kandidat;
      }
    }
    if (beste) return beste.filmMs + (beste.art === 'anfang' ? s / 2 : -s / 2);
    // Verschmolzen: Der Griff ist aufgegangen – dann im Abschnitt bleiben.
    const start = filmAnfangMs(abschnitte, griff.nummer);
    const ende = filmAnfangMs(abschnitte, griff.nummer + 1);
    return Math.min(ende - s / 2, Math.max(start + s / 2, fingerMs));
  };

  const ziehen = (klientX: number) => {
    const z = zug.current;
    if (!z) return;
    const a = Math.min(1, Math.max(0, (klientX - z.links) / z.breite));
    const fingerMs = a * umfangMs;
    const neu = griffZiehen(z.geltung, z.griff, fingerMs, bezug);
    z.bewegt = true;
    if (leiste.onGeltung(maske.id, neu, false)) z.letzte = neu;
    z.filmMs = griffStelle(z.letzte, z.griff, fingerMs);
    leiste.onGriffZug?.(z.filmMs, false);
  };

  const loslassen = () => {
    const z = zug.current;
    zug.current = null;
    if (!z) return;
    z.weg();
    // Ein Tipp ohne Bewegung ändert nichts – kein Neuladen, kein ↺.
    if (z.bewegt) leiste.onGeltung(maske.id, z.letzte, true);
    leiste.onGriffZug?.(z.filmMs, true);
  };
  const loslassenRef = useRef(loslassen);
  loslassenRef.current = loslassen;
  const ziehenRef = useRef(ziehen);
  ziehenRef.current = ziehen;
  // Verschwindet der Griff mitsamt dem Zug, endet der Zug trotzdem.
  useEffect(() => () => loslassenRef.current(), []);

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
              /*
               * Am Fenster gelauscht, nicht am Knopf: Verschmilzt der Zeitraum
               * beim Ziehen mit einem anderen, verschwindet dieser Knopf – und
               * mit ihm jede Nachricht vom Loslassen.
               */
              const bewegen = (e: PointerEvent) => ziehenRef.current(e.clientX);
              const ende = () => loslassenRef.current();
              window.addEventListener('pointermove', bewegen);
              window.addEventListener('pointerup', ende);
              window.addEventListener('pointercancel', ende);
              zug.current = {
                griff,
                geltung: maske.geltung,
                links: kasten.left,
                breite: kasten.width,
                letzte: maske.geltung,
                filmMs: griff.filmMs + (griff.art === 'anfang' ? s / 2 : -s / 2),
                bewegt: false,
                weg: () => {
                  window.removeEventListener('pointermove', bewegen);
                  window.removeEventListener('pointerup', ende);
                  window.removeEventListener('pointercancel', ende);
                },
              };
            }}
            onKeyDown={(ereignis) => {
              if (ereignis.key !== 'ArrowLeft' && ereignis.key !== 'ArrowRight') return;
              ereignis.preventDefault();
              // Sonst liefe die Wiedergabestelle mit – ihr Tastenhandler sitzt darüber.
              ereignis.stopPropagation();
              const weite = (ereignis.shiftKey ? 10 : 1) * s;
              const richtung = ereignis.key === 'ArrowLeft' ? -1 : 1;
              // Von der Kante aus: Kante ± n Bilder liegt genau n Kanten
              // weiter und rundet eindeutig.
              const neu = griffZiehen(maske.geltung, griff, griff.filmMs + richtung * weite, bezug);
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
  bahnWerte,
}: {
  leiste: MaskenLeiste;
  abschnitte: readonly Abschnitt[];
  s: number;
  spielkopfMs: number;
  onZurStelle: (filmMs: number) => void;
  /** Was vor den Einstellungen stehen bleibt – der Abspielknopf. */
  vorne?: ReactNode;
  /** Was die Bahnen gerechnet haben – „Zur Maske" sucht darin. */
  bahnWerte?: RefObject<BahnWerte | null>;
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
  const fortschritt = leiste.jeMaske.get(maske.id);
  const fehler = fortschritt?.fehler;
  const stand = fehler ? '' : maskenStand(fortschritt);
  const leer = geltungLeer(g, bezug);

  /**
   * Die nächste Stelle im Film, an der die Maske zu sehen ist – gelesen in
   * dem, was die Bahn schon gerechnet hat, vom Kopf aus nach aussen.
   */
  const zurMaske = () => {
    const bahn = bahnWerte?.current;
    const werte = bahn?.werte.get(maske.id);
    let beste: number | null = null;
    if (bahn && werte && werte.length > 0) {
      const msJe = bahn.umfangMs / werte.length;
      const ende = filmEnde(abschnitte);
      const kopf = Math.min(werte.length - 1, Math.floor(spielkopfMs / msJe));
      for (let d = 0; d < werte.length && beste === null; d += 1) {
        for (const x of [kopf - d, kopf + d]) {
          if (x >= 0 && x < werte.length && zuSehen(werte[x])) {
            beste = Math.min(ende - s / 2, (x + 0.5) * msJe);
            break;
          }
        }
      }
    }
    if (beste === null) {
      // Noch nirgends zu sehen: dorthin, wo sie eingestellt wurde.
      const anker = ankerStellen(maske, abschnitte, s);
      if (anker.length > 0) beste = anker[0];
    }
    if (beste !== null) onZurStelle(beste);
  };

  const halten = {
    onFocus: () => leiste.onZurueckHalten?.(true),
    onBlur: () => leiste.onZurueckHalten?.(false),
    onPointerEnter: () => leiste.onZurueckHalten?.(true),
    onPointerLeave: () => leiste.onZurueckHalten?.(false),
  };

  return (
    <>
      <div className="zl-leiste mb-chips" role="toolbar" aria-label={`Maske ${maske.name}`}>
        {/*
            Reihenfolge nach Gewicht, nicht nach Entstehung: Vorne steht, was
            man ständig braucht (Abspielen, welche Maske, wo sie gilt, ob sie
            wirkt, löschen), dahinter, was seltener ist. Auf einem Telefon
            lässt sich der Schieber seitlich bewegen – das Wichtige soll dort
            liegen, wo man es ohne Wischen sieht, und „Fertig" steht fest
            daneben: Es ist der Rückweg zu den Schnittknöpfen und darf nie
            hinter einer Kante liegen.
        */}
        {vorne}
        <div className="mb-schieber">
          <span
            className="mb-name"
            style={{ ['--mb-farbe' as string]: `var(--maske-${maske.farbe % 8})` }}
            title={stand ? `${maske.name} · ${stand}` : maske.name}
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
              onClick={() => {
                if (!ganz) setzen({ art: 'ganz' });
              }}
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
          {/*
              Ein Umschalter mit FESTEM Namen: „wirkt", gedrückt oder nicht.
              Ein Name, der mit dem Zustand wechselt („ausschalten" –
              gedrückt), sagte einer Vorlesehilfe das Gegenteil.
          */}
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={maske.aktiv}
            onClick={() => leiste.onAn(maske.id, !maske.aktiv)}
            title={maske.aktiv ? 'Maske ausschalten' : 'Maske einschalten'}
            aria-label={`„${maske.name}" wirkt`}
          >
            {maske.aktiv ? '👁' : '🚫'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => leiste.onLoeschen(maske.id)}
            aria-label={`Maske „${maske.name}" löschen`}
          >
            🗑
          </button>
          {abschnitte.length > 1 && abschnittHier && hier && (
            <button
              type="button"
              className={`btn btn-sm${nurHier ? ' is-active' : ''}`}
              aria-pressed={nurHier}
              onClick={() => {
                if (!nurHier) setzen(geltungNurAbschnitt(abschnittHier.id));
              }}
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
            onClick={() => leiste.onTrennen(maske.id, spielkopfMs)}
            title="Zwei Masken daraus machen, getrennt an der Wiedergabestelle – dann lassen sie sich verschieden einstellen"
          >
            Hier trennen
          </button>
          {leiste.zurueckMoeglich && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={leiste.onZurueck}
              aria-label="Letzte Änderung an den Masken zurücknehmen"
              {...halten}
            >
              ↺
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => leiste.onWaehlen(null)}
          /*
           * Ein eigener Name: Der Editor hat unten schon ein „Fertig", das ihn
           * schliesst. Zwei gleich benannte Knöpfe liessen eine Vorlesehilfe
           * raten, welcher was tut.
           */
          aria-label="Maske fertig – zurück zu den Knöpfen der Zeitleiste"
        >
          Fertig
        </button>
      </div>
      {fehler && (
        <p className="mb-hinweis" role="status">
          „{maske.name}": {fehler}
        </p>
      )}
      {leer && (
        <p className="mb-hinweis" role="status">
          Der Abschnitt dieser Maske ist nicht mehr im Film – sie wirkt nirgends.
        </p>
      )}
    </>
  );
}

/**
 * Die Namen der Masken zur Wahl – nach einem Tipp auf die Sammelbahn, oder
 * über den Knopf „Masken" (auch mit der Tastatur erreichbar).
 */
export function MaskenNamen({
  leiste,
  vorne,
  onZu,
}: {
  leiste: MaskenLeiste;
  vorne?: ReactNode;
  onZu: () => void;
}) {
  const erster = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    erster.current?.focus();
  }, []);
  return (
    <div className="zl-leiste mb-chips" role="toolbar" aria-label="Maske wählen">
      {vorne}
      {leiste.masken.map((maske, i) => (
        <button
          key={maske.id}
          ref={i === 0 ? erster : undefined}
          type="button"
          className="btn btn-sm mb-namenwahl"
          style={{ ['--mb-farbe' as string]: `var(--maske-${maske.farbe % 8})` }}
          onClick={() => {
            leiste.onWaehlen(maske.id);
            onZu();
          }}
        >
          <span className="mb-punkt" aria-hidden="true" />
          {maske.aktiv ? '' : '✗ '}
          {maske.name}
        </button>
      ))}
      {leiste.onNeu && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            leiste.onNeu?.();
            onZu();
          }}
        >
          ＋ Bereich
        </button>
      )}
      <button type="button" className="btn btn-sm" onClick={onZu}>
        Abbrechen
      </button>
    </div>
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
