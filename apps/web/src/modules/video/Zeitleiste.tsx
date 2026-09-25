import { useRef, useState } from 'react';

import { kannTeilen } from './ausschnitt.js';
import {
  filmAnfangMs,
  filmDauerMs,
  filmZuQuelle,
  quelleZuFilm,
  type Abschnitt,
} from './schnitt.js';

/**
 * Die Zeitleiste: der Film als Reihe von Abschnitten, wie in einem
 * Schnittprogramm.
 *
 * # Warum FILMreihenfolge und nicht das Quellvideo
 *
 * Der Streifen, der hier vorher stand, zeigte das Quellvideo und darauf
 * markiert die gewählten Stücke. Das beantwortet „welche Stellen nehme
 * ich?", aber nicht „wie sieht mein Film aus?" – und die zweite Frage stellt
 * sich, sobald ein Abschnitt vor einen früheren gezogen oder derselbe
 * zweimal genommen wird. Hier liegen die Abschnitte so nebeneinander, wie
 * sie laufen, jeder so breit wie er lang ist.
 *
 * # Warum die Leiste Platz nach hinten lässt
 *
 * Damit sich das Ende des letzten Abschnitts nach hinten ziehen lässt. Eine
 * Leiste, die immer genau den Film zeigt, hätte am rechten Rand keinen Raum
 * zum Verlängern.
 *
 * # Wer was entscheidet
 *
 * Die Leiste meldet nur: Wiedergabestelle, gewählter Abschnitt, neue
 * Grenzen. Was daraus folgt – ein anderes Standbild im Editor, Masken, die
 * mitgenommen werden müssen –, entscheidet der Aufrufer. Deshalb kommt jede
 * Meldung zweimal: während des Ziehens (`fertig: false`, für die Anzeige)
 * und beim Loslassen (`fertig: true`, für alles, was Arbeit kostet).
 */
export interface ZeitleisteProps {
  abschnitte: readonly Abschnitt[];
  aktiv: number;
  /** Die Wiedergabestelle im FILM. */
  spielkopfMs: number;
  /** Wie lang das Quellvideo ist – die Grenze beim Verlängern. */
  quelleMs: number;
  /** Ein Bild des Films – so weit schiebt eine Pfeiltaste, so kurz wird kein Abschnitt. */
  schrittMs: number;
  /** Standbilder aus dem Quellvideo, gleichmässig verteilt. */
  vorschau: readonly { zeitMs: number; bild: string }[];
  spielt: boolean;
  gesperrt?: boolean;
  /** Abschnitte, an denen gerade gerechnet wird – die zeigen einen Kreisel. */
  beschaeftigt?: ReadonlySet<string>;
  /** Wo im FILM das Stellbild des gewählten Abschnitts liegt – ohne Angabe kein Zeichen. */
  stellbildMs?: number | null;
  onSpielkopf: (filmMs: number, fertig: boolean) => void;
  onKuerzen: (nummer: number, vonMs: number, bisMs: number, fertig: boolean) => void;
  onAbspielen: () => void;
  onTeilen: () => void;
  onEntfernen: () => void;
  onVerschieben: (richtung: -1 | 1) => void;
  onDazu: () => void;
}

interface Griff {
  welcher: 'von' | 'bis';
  startX: number;
  /** Millisekunden je Bildpunkt – beim Anfassen festgehalten, sonst zöge die Leiste unter dem Finger mit. */
  msJePunkt: number;
  von: number;
  bis: number;
}

export function Zeitleiste({
  abschnitte,
  aktiv,
  spielkopfMs,
  quelleMs,
  schrittMs,
  vorschau,
  spielt,
  gesperrt = false,
  beschaeftigt,
  stellbildMs,
  onSpielkopf,
  onKuerzen,
  onAbspielen,
  onTeilen,
  onEntfernen,
  onVerschieben,
  onDazu,
}: ZeitleisteProps) {
  const bahn = useRef<HTMLDivElement | null>(null);
  const kopfZieht = useRef(false);
  const griff = useRef<Griff | null>(null);
  /*
   * Der Massstab steht still, solange ein Finger auf der Leiste liegt.
   *
   * Er hängt an der Filmlänge, und die ändert sich beim Kürzen mit jedem
   * Bildpunkt. Rechnete die Leiste währenddessen neu, liefe der Griff dem
   * Finger davon.
   */
  const [festerUmfang, setFesterUmfang] = useState<number | null>(null);
  /**
   * Die Grenzen des gewählten Abschnitts, solange ein Griff gezogen wird.
   *
   * Nur angezeigt, noch nicht übernommen: Übernommen rückten alle späteren
   * Abschnitte bei jedem Bildpunkt nach, und beim Ziehen am ANFANG liefe
   * dann das Ende des Abschnitts unter dem Finger weg. Übernommen wird beim
   * Loslassen.
   */
  const [zug, setZug] = useState<{ vonMs: number; bisMs: number } | null>(null);

  const gesamt = filmDauerMs(abschnitte);
  const umfang = festerUmfang ?? Math.max(1, gesamt * 1.25, gesamt + 1500);
  const mindest = Math.max(1, Math.round(schrittMs));
  const anteil = (ms: number) => Math.min(1, Math.max(0, ms / umfang));

  const filmAus = (klientX: number): number => {
    const kasten = bahn.current?.getBoundingClientRect();
    if (!kasten || kasten.width === 0) return 0;
    const a = Math.min(1, Math.max(0, (klientX - kasten.left) / kasten.width));
    return Math.min(gesamt, Math.round(a * umfang));
  };

  const msJePunkt = (): number => {
    const breite = bahn.current?.getBoundingClientRect().width ?? 0;
    return breite > 0 ? umfang / breite : 0;
  };

  const ort = filmZuQuelle(abschnitte, spielkopfMs);
  const unterKopf = ort ? abschnitte[ort.nummer] : undefined;
  const teilbar =
    !gesperrt &&
    unterKopf !== undefined &&
    ort !== null &&
    kannTeilen(unterKopf, ort.quelleMs, mindest);

  const griffZiehen = (klientX: number, fertig: boolean) => {
    const g = griff.current;
    if (!g) return;
    const weg = (klientX - g.startX) * g.msJePunkt;
    const von = g.welcher === 'von' ? Math.max(0, Math.min(g.bis - mindest, g.von + weg)) : g.von;
    const bis =
      g.welcher === 'bis' ? Math.min(quelleMs, Math.max(g.von + mindest, g.bis + weg)) : g.bis;
    setZug(fertig ? null : { vonMs: von, bisMs: bis });
    onKuerzen(aktiv, Math.round(von), Math.round(bis), fertig);
  };

  const loslassen = (klientX: number) => {
    if (griff.current) {
      griffZiehen(klientX, true);
      griff.current = null;
    } else if (kopfZieht.current) {
      onSpielkopf(filmAus(klientX), true);
    }
    kopfZieht.current = false;
    setFesterUmfang(null);
  };

  return (
    <div className={`zl${gesperrt ? ' ist-aus' : ''}`}>
      <div className="zl-leiste">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onAbspielen}
          disabled={gesperrt}
          aria-label={spielt ? 'Anhalten' : 'Abspielen'}
        >
          {spielt ? '⏸' : '▶'}
        </button>
        <span className="zl-zeit">
          {zeitText(spielkopfMs)} / {zeitText(gesamt)}
        </span>
        <span className="zl-luecke" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={onTeilen}
          disabled={!teilbar}
          title="Teilt den Abschnitt an der Wiedergabestelle – beide Hälften behalten die Bearbeitung"
          aria-label="An der Wiedergabestelle teilen"
        >
          ✂
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onVerschieben(-1)}
          disabled={gesperrt || aktiv <= 0}
          aria-label={`Abschnitt ${aktiv + 1} nach vorn`}
          title="Den gewählten Abschnitt eine Stelle nach vorn"
        >
          {/* Pfeile und nicht ◀ ▶ – daneben steht der Abspielknopf. */}←
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onVerschieben(1)}
          disabled={gesperrt || aktiv >= abschnitte.length - 1}
          aria-label={`Abschnitt ${aktiv + 1} nach hinten`}
          title="Den gewählten Abschnitt eine Stelle nach hinten"
        >
          →
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onEntfernen}
          disabled={gesperrt || abschnitte.length <= 1}
          aria-label={`Abschnitt ${aktiv + 1} entfernen`}
        >
          🗑
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onDazu}
          disabled={gesperrt || quelleMs <= 0}
          aria-label="Abschnitt hinzufügen"
          title="Hängt hinter dem gewählten einen weiteren Abschnitt an – mit derselben Bearbeitung"
        >
          ＋
        </button>
      </div>

      <div
        ref={bahn}
        className="zl-bahn"
        role="slider"
        tabIndex={gesperrt ? -1 : 0}
        aria-label="Wiedergabestelle"
        aria-valuemin={0}
        aria-valuemax={Math.round(gesamt)}
        aria-valuenow={Math.round(spielkopfMs)}
        aria-valuetext={zeitText(spielkopfMs)}
        onPointerDown={(ereignis) => {
          if (gesperrt) return;
          kopfZieht.current = true;
          setFesterUmfang(umfang);
          ereignis.currentTarget.setPointerCapture(ereignis.pointerId);
          onSpielkopf(filmAus(ereignis.clientX), false);
        }}
        onPointerMove={(ereignis) => {
          if (griff.current) griffZiehen(ereignis.clientX, false);
          else if (kopfZieht.current) onSpielkopf(filmAus(ereignis.clientX), false);
        }}
        onPointerUp={(ereignis) => loslassen(ereignis.clientX)}
        onPointerCancel={(ereignis) => loslassen(ereignis.clientX)}
        onKeyDown={(ereignis) => {
          // Bildgenau mit den Pfeiltasten, mit Umschalt zehn Bilder weit.
          if (ereignis.key !== 'ArrowLeft' && ereignis.key !== 'ArrowRight') return;
          ereignis.preventDefault();
          const weite = (ereignis.shiftKey ? 10 : 1) * schrittMs;
          const ziel = spielkopfMs + (ereignis.key === 'ArrowLeft' ? -weite : weite);
          onSpielkopf(Math.max(0, Math.min(gesamt, ziel)), true);
        }}
      >
        {abschnitte.map((abschnitt, nummer) => {
          const istAktiv = nummer === aktiv;
          const grenzen = istAktiv && zug ? zug : abschnitt;
          // Während des Ziehens am Anfang wandert die linke Kante mit dem
          // Finger, die rechte bleibt stehen.
          const start = filmAnfangMs(abschnitte, nummer) + (grenzen.vonMs - abschnitt.vonMs);
          const laenge = Math.max(0, grenzen.bisMs - grenzen.vonMs);
          const links = anteil(start) * 100;
          const breite = (anteil(start + laenge) - anteil(start)) * 100;
          return (
            <div
              key={abschnitt.id}
              className={`zl-abschnitt${istAktiv ? ' ist-aktiv' : ''}`}
              style={{ left: `${links}%`, width: `${breite}%` }}
            >
              <div className="zl-bilder" aria-hidden="true">
                {bilderFuer(abschnitt, vorschau).map((bild) => (
                  <img key={bild.zeitMs} src={bild.bild} alt="" draggable={false} />
                ))}
              </div>
              <span className="zl-nummer">
                {nummer + 1}
                {abschnitt.doc && ' ✎'}
                {beschaeftigt?.has(abschnitt.id) && (
                  <span className="spinner zl-kreisel" aria-label="wird gerechnet" />
                )}
              </span>
              {istAktiv &&
                (['von', 'bis'] as const).map((welcher) => (
                  <button
                    key={welcher}
                    type="button"
                    className={`zl-griff zl-griff-${welcher}`}
                    disabled={gesperrt}
                    aria-label={welcher === 'von' ? 'Anfang des Abschnitts' : 'Ende des Abschnitts'}
                    onPointerDown={(ereignis) => {
                      ereignis.stopPropagation();
                      const faktor = msJePunkt();
                      if (faktor <= 0) return;
                      griff.current = {
                        welcher,
                        startX: ereignis.clientX,
                        msJePunkt: faktor,
                        von: abschnitt.vonMs,
                        bis: abschnitt.bisMs,
                      };
                      setFesterUmfang(umfang);
                      bahn.current?.setPointerCapture(ereignis.pointerId);
                    }}
                    onKeyDown={(ereignis) => {
                      if (ereignis.key !== 'ArrowLeft' && ereignis.key !== 'ArrowRight') return;
                      ereignis.preventDefault();
                      ereignis.stopPropagation();
                      const weite = (ereignis.shiftKey ? 10 : 1) * mindest;
                      const richtung = ereignis.key === 'ArrowLeft' ? -weite : weite;
                      if (welcher === 'von') {
                        const von = Math.max(
                          0,
                          Math.min(abschnitt.bisMs - mindest, abschnitt.vonMs + richtung),
                        );
                        onKuerzen(nummer, von, abschnitt.bisMs, true);
                      } else {
                        const bis = Math.min(
                          quelleMs,
                          Math.max(abschnitt.vonMs + mindest, abschnitt.bisMs + richtung),
                        );
                        onKuerzen(nummer, abschnitt.vonMs, bis, true);
                      }
                    }}
                  />
                ))}
            </div>
          );
        })}
        {stellbildMs != null && (
          <div
            className="zl-stellbild"
            style={{ left: `${anteil(stellbildMs) * 100}%` }}
            title="Hier wird eingestellt"
          />
        )}
        <div className="zl-kopf" style={{ left: `${anteil(spielkopfMs) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Welche Vorschaubilder in einen Abschnitt gehören: die aus seinem Bereich
 * im Quellvideo, und ist keines darin, das nächstgelegene – ein leerer
 * Kasten sähe aus wie ein Abschnitt ohne Bild.
 */
export function bilderFuer(
  abschnitt: { vonMs: number; bisMs: number },
  vorschau: readonly { zeitMs: number; bild: string }[],
): { zeitMs: number; bild: string }[] {
  const drin = vorschau.filter(
    (bild) => bild.zeitMs >= abschnitt.vonMs && bild.zeitMs < abschnitt.bisMs,
  );
  if (drin.length > 0 || vorschau.length === 0) return drin;
  const mitte = (abschnitt.vonMs + abschnitt.bisMs) / 2;
  let naechstes = vorschau[0];
  for (const bild of vorschau) {
    if (Math.abs(bild.zeitMs - mitte) < Math.abs(naechstes.zeitMs - mitte)) naechstes = bild;
  }
  return [naechstes];
}

/** „0:02,45" – eine Zeit, die man ablesen und vergleichen kann. */
export function zeitText(ms: number): string {
  const gesamt = Math.max(0, ms);
  const minuten = Math.floor(gesamt / 60_000);
  const sekunden = Math.floor((gesamt % 60_000) / 1000);
  const hundertstel = Math.floor((gesamt % 1000) / 10);
  return `${minuten}:${String(sekunden).padStart(2, '0')},${String(hundertstel).padStart(2, '0')}`;
}

/** Die Stelle des Stellbildes im Film – oder `null`, wenn es keines gibt. */
export function stellbildImFilm(abschnitte: readonly Abschnitt[], nummer: number): number | null {
  const abschnitt = abschnitte[nummer];
  if (!abschnitt) return null;
  return quelleZuFilm(abschnitte, nummer, abschnitt.standMs);
}
