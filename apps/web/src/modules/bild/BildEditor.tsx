import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { dialogAnmelden } from '../../lib/dialogVerlauf.js';
import { toast, useHideNav } from '../../state/ui.js';
import { errorMessage, loadImageFromBlob } from '../stickers/helpers.js';
import {
  ansichtAlsZuschnitt,
  ansichtGroesse,
  aufVerhaeltnis,
  docKopie,
  docUnberuehrt,
  nachAnsicht,
  nachOriginal,
  neuesDoc,
  weiterdrehen,
  zuschnittHalten,
  zuschnittInAnsicht,
  type BildDoc,
  type Schriftzug,
  type Zuschnitt,
} from './doc.js';
import { SCHRIFTEN, trifftText, zeichneAnsicht, zeichneAusgabe } from './zeichnen.js';
import './styles.css';

type Werkzeug = 'zuschnitt' | 'malen' | 'text';

const FARBEN = [
  '#ffffff',
  '#111111',
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#0a84ff',
  '#af52de',
];

const VERHAELTNISSE: { label: string; wert: number | null }[] = [
  { label: 'Frei', wert: null },
  { label: '1:1', wert: 1 },
  { label: '4:5', wert: 4 / 5 },
  { label: '3:2', wert: 3 / 2 },
  { label: '16:9', wert: 16 / 9 },
];

/** Die Anzeigeauflösung der Arbeitsfläche – mehr sieht niemand, kostet aber. */
const ANSICHT_KANTE = 1400;

const VERLAUF_MAX = 25;

interface BildEditorProps {
  /** Das zu bearbeitende Bild. */
  quelle: Blob;
  /** Name des Originals – der Vorschlag für die bearbeitete Fassung. */
  name?: string | null;
  onClose: () => void;
  /**
   * Wohin das Ergebnis geht. Fehlt es, bleibt nur „auf dem Handy speichern“ –
   * ein Editor ohne Ziel wäre eine Sackgasse, deshalb sagt der Knopf dann auch
   * genau das.
   */
  onFertig?: (blob: Blob, name: string) => Promise<void> | void;
  zielName?: string;
}

/** `foto.jpg` → `foto-bearbeitet.webp`. Das Original behält seinen Namen. */
function bearbeiteterName(name: string | null | undefined, endung: string): string {
  const roh = (name ?? 'bild').replace(/\.[^.]+$/, '');
  const kurz = roh.length > 60 ? roh.slice(0, 60) : roh;
  return `${kurz || 'bild'}-bearbeitet.${endung}`;
}

/**
 * Der Bildeditor: zuschneiden, drehen, malen, beschriften.
 *
 * Er überschreibt nie das Original. Das Ergebnis ist eine eigene Datei, die
 * entweder dort landet, wo das Original liegt (Chat oder Sammlung), oder auf
 * dem Telefon – oder beides.
 */
export function BildEditor({ quelle, name, onClose, onFertig, zielName }: BildEditorProps) {
  useHideNav(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bild, setBild] = useState<HTMLImageElement | null>(null);
  const [doc, setDoc] = useState<BildDoc | null>(null);
  const [werkzeug, setWerkzeug] = useState<Werkzeug>('zuschnitt');
  const [farbe, setFarbe] = useState('#ff3b30');
  const [breite, setBreite] = useState(14);
  const [gewaehlterText, setGewaehlterText] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [speichert, setSpeichert] = useState(false);
  const [kannZurueck, setKannZurueck] = useState(false);

  const docRef = useRef<BildDoc | null>(null);
  const bildRef = useRef<HTMLImageElement | null>(null);
  const werkzeugRef = useRef(werkzeug);
  const farbeRef = useRef(farbe);
  const breiteRef = useRef(breite);
  const gewaehltRef = useRef<string | null>(null);
  const verlauf = useRef<BildDoc[]>([]);
  const massRef = useRef({ faktor: 1, breite: 1, hoehe: 1 });
  const rahmen = useRef<number | null>(null);
  const zug = useRef<{
    art: 'keiner' | 'zuschnitt' | 'malen' | 'text';
    griff: string;
    start: { x: number; y: number };
    startZ: Zuschnitt;
    startText: { x: number; y: number };
  }>({
    art: 'keiner',
    griff: '',
    start: { x: 0, y: 0 },
    startZ: { x: 0, y: 0, w: 0, h: 0 },
    startText: { x: 0, y: 0 },
  });

  useEffect(() => {
    werkzeugRef.current = werkzeug;
  }, [werkzeug]);
  useEffect(() => {
    farbeRef.current = farbe;
  }, [farbe]);
  useEffect(() => {
    breiteRef.current = breite;
  }, [breite]);
  useEffect(() => {
    gewaehltRef.current = gewaehlterText;
  }, [gewaehlterText]);

  const zeichnen = useCallback(() => {
    const canvas = canvasRef.current;
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!canvas || !quellBild || !aktuell) return;
    const mass = zeichneAnsicht(
      canvas,
      quellBild,
      quellBild.naturalWidth,
      quellBild.naturalHeight,
      aktuell,
      { maxKante: ANSICHT_KANTE, zuschnittZeigen: werkzeugRef.current === 'zuschnitt' },
    );
    if (mass) massRef.current = mass;
  }, []);

  const planen = useCallback(() => {
    if (rahmen.current != null) cancelAnimationFrame(rahmen.current);
    rahmen.current = window.requestAnimationFrame(() => {
      rahmen.current = null;
      zeichnen();
    });
  }, [zeichnen]);

  useEffect(() => {
    docRef.current = doc;
    bildRef.current = bild;
    planen();
  }, [doc, bild, planen]);

  useEffect(() => {
    planen();
  }, [werkzeug, planen]);

  // Zurück-Taste schliesst den Editor, statt aus der App zu fallen.
  useEffect(() => dialogAnmelden(onClose), [onClose]);

  useEffect(() => {
    let weg = false;
    loadImageFromBlob(quelle)
      .then((geladen) => {
        if (weg) return;
        setBild(geladen);
        setDoc(neuesDoc(geladen.naturalWidth, geladen.naturalHeight));
      })
      .catch((error: unknown) => {
        if (weg) return;
        toast(errorMessage(error, 'Das Bild konnte nicht geladen werden'), 'error');
        onClose();
      })
      .finally(() => {
        if (!weg) setLaedt(false);
      });
    return () => {
      weg = true;
    };
  }, [quelle, onClose]);

  /** Merkt den Stand für „Rückgängig“. */
  const merken = useCallback(() => {
    const aktuell = docRef.current;
    if (!aktuell) return;
    verlauf.current = [...verlauf.current, docKopie(aktuell)].slice(-VERLAUF_MAX);
    setKannZurueck(true);
  }, []);

  const zurueck = useCallback(() => {
    const vorher = verlauf.current[verlauf.current.length - 1];
    if (!vorher) return;
    verlauf.current = verlauf.current.slice(0, -1);
    setKannZurueck(verlauf.current.length > 0);
    setDoc(vorher);
  }, []);

  /* ---------- Umrechnung Bildschirm → Ansicht ---------- */

  function ansichtsPunkt(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const proPixel = massRef.current.breite / (rect.width || 1);
    return {
      x: ((clientX - rect.left) * proPixel) / massRef.current.faktor,
      y: ((clientY - rect.top) * proPixel) / massRef.current.faktor,
    };
  }

  /** Welcher Griff des Zuschnittrahmens am nächsten liegt – oder „innen“. */
  function griffAn(punkt: { x: number; y: number }, z: Zuschnitt): string {
    // In Ansichtspunkten, damit der Fangbereich auf jedem Bild gleich gross wirkt.
    const nah = Math.max(28 / massRef.current.faktor, Math.min(z.w, z.h) * 0.2);
    const links = Math.abs(punkt.x - z.x) < nah;
    const rechts = Math.abs(punkt.x - (z.x + z.w)) < nah;
    const oben = Math.abs(punkt.y - z.y) < nah;
    const unten = Math.abs(punkt.y - (z.y + z.h)) < nah;
    if (links && oben) return 'lo';
    if (rechts && oben) return 'ro';
    if (links && unten) return 'lu';
    if (rechts && unten) return 'ru';
    if (links) return 'l';
    if (rechts) return 'r';
    if (oben) return 'o';
    if (unten) return 'u';
    return 'innen';
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const aktuell = docRef.current;
    const quellBild = bildRef.current;
    if (!aktuell || !quellBild) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* nicht überall vorhanden, nicht schlimm */
    }
    const punkt = ansichtsPunkt(event.clientX, event.clientY);
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;

    if (werkzeugRef.current === 'zuschnitt') {
      const inAnsicht = zuschnittInAnsicht(aktuell.zuschnitt, W, H, aktuell);
      merken();
      zug.current = {
        art: 'zuschnitt',
        griff: griffAn(punkt, inAnsicht),
        start: punkt,
        startZ: inAnsicht,
        startText: { x: 0, y: 0 },
      };
      return;
    }

    if (werkzeugRef.current === 'malen') {
      merken();
      const amBild = nachOriginal(punkt, W, H, aktuell);
      zug.current = { ...zug.current, art: 'malen' };
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              striche: [
                ...wert.striche,
                { farbe: farbeRef.current, breite: breiteRef.current, punkte: [amBild.x, amBild.y] },
              ],
            }
          : wert,
      );
      return;
    }

    // Text: einen vorhandenen greifen, sonst den gewählten dorthin setzen.
    const ctx = canvasRef.current?.getContext('2d');
    const getroffen = ctx
      ? [...aktuell.texte]
          .reverse()
          .find((text) =>
            trifftText(ctx, text, nachAnsicht({ x: text.x, y: text.y }, W, H, aktuell), punkt),
          )
      : undefined;
    if (getroffen) {
      merken();
      setGewaehlterText(getroffen.id);
      zug.current = {
        art: 'text',
        griff: getroffen.id,
        start: punkt,
        startZ: { x: 0, y: 0, w: 0, h: 0 },
        startText: { x: getroffen.x, y: getroffen.y },
      };
      return;
    }
    const gewaehlt = aktuell.texte.find((text) => text.id === gewaehltRef.current);
    if (gewaehlt) {
      merken();
      const amBild = nachOriginal(punkt, W, H, aktuell);
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              texte: wert.texte.map((text) =>
                text.id === gewaehlt.id ? { ...text, x: amBild.x, y: amBild.y } : text,
              ),
            }
          : wert,
      );
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const art = zug.current.art;
    if (art === 'keiner') return;
    const aktuell = docRef.current;
    const quellBild = bildRef.current;
    if (!aktuell || !quellBild) return;
    const punkt = ansichtsPunkt(event.clientX, event.clientY);
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;

    if (art === 'zuschnitt') {
      const start = zug.current.startZ;
      const dx = punkt.x - zug.current.start.x;
      const dy = punkt.y - zug.current.start.y;
      const griff = zug.current.griff;
      let rechteck: Zuschnitt;
      if (griff === 'innen') {
        rechteck = { ...start, x: start.x + dx, y: start.y + dy };
      } else {
        let { x, y, w, h } = start;
        if (griff.includes('l')) {
          x = start.x + dx;
          w = start.w - dx;
        }
        if (griff.includes('r')) w = start.w + dx;
        if (griff.includes('o')) {
          y = start.y + dy;
          h = start.h - dy;
        }
        if (griff.includes('u')) h = start.h + dy;
        // Über den gegenüberliegenden Rand hinausgezogen: das Rechteck klappt
        // um, statt eine negative Breite zu bekommen.
        if (w < 0) {
          x += w;
          w = -w;
        }
        if (h < 0) {
          y += h;
          h = -h;
        }
        rechteck = { x, y, w, h };
      }
      const sicht = ansichtGroesse(W, H, aktuell.drehung);
      const gehalten = zuschnittHalten(rechteck, sicht.w, sicht.h);
      const amBild = ansichtAlsZuschnitt(gehalten, W, H, aktuell);
      setDoc((wert) => (wert ? { ...wert, zuschnitt: amBild } : wert));
      return;
    }

    if (art === 'malen') {
      const amBild = nachOriginal(punkt, W, H, aktuell);
      setDoc((wert) => {
        if (!wert) return wert;
        const striche = wert.striche.slice();
        const letzter = striche[striche.length - 1];
        if (!letzter) return wert;
        striche[striche.length - 1] = {
          ...letzter,
          punkte: [...letzter.punkte, amBild.x, amBild.y],
        };
        return { ...wert, striche };
      });
      return;
    }

    if (art === 'text') {
      const start = nachAnsicht(zug.current.startText, W, H, aktuell);
      const ziel = nachOriginal(
        { x: start.x + (punkt.x - zug.current.start.x), y: start.y + (punkt.y - zug.current.start.y) },
        W,
        H,
        aktuell,
      );
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              texte: wert.texte.map((text) =>
                text.id === zug.current.griff ? { ...text, x: ziel.x, y: ziel.y } : text,
              ),
            }
          : wert,
      );
    }
  }

  function onPointerUp() {
    zug.current = { ...zug.current, art: 'keiner' };
  }

  /* ---------- Werkzeugbefehle ---------- */

  function drehen(schritte: number) {
    merken();
    setDoc((wert) => (wert ? { ...wert, drehung: weiterdrehen(wert.drehung, schritte) } : wert));
  }

  function spiegeln() {
    merken();
    setDoc((wert) => (wert ? { ...wert, spiegel: !wert.spiegel } : wert));
  }

  function verhaeltnisSetzen(wert: number | null) {
    if (!bild || wert === null) return;
    merken();
    setDoc((aktuell) =>
      aktuell
        ? {
            ...aktuell,
            zuschnitt: aufVerhaeltnis(
              aktuell.zuschnitt,
              // Das Verhältnis gilt für das, was man sieht; am hochkant
              // gedrehten Bild ist „16:9“ also quer zum Original.
              aktuell.drehung === 90 || aktuell.drehung === 270 ? 1 / wert : wert,
              bild.naturalWidth,
              bild.naturalHeight,
            ),
          }
        : aktuell,
    );
  }

  function zuschnittGanz() {
    if (!bild) return;
    merken();
    setDoc((wert) =>
      wert
        ? { ...wert, zuschnitt: { x: 0, y: 0, w: bild.naturalWidth, h: bild.naturalHeight } }
        : wert,
    );
  }

  function textHinzufuegen() {
    if (!bild || !doc) return;
    merken();
    const id = `t${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
    const sicht = ansichtGroesse(bild.naturalWidth, bild.naturalHeight, doc.drehung);
    const mitte = nachOriginal(
      { x: sicht.w / 2, y: sicht.h / 2 },
      bild.naturalWidth,
      bild.naturalHeight,
      doc,
    );
    const neu: Schriftzug = {
      id,
      text: 'Text',
      x: mitte.x,
      y: mitte.y,
      groesse: Math.round(Math.max(sicht.w, sicht.h) / 12),
      farbe: '#ffffff',
      kontur: '#111111',
      schrift: 'system',
      fett: true,
    };
    setDoc((wert) => (wert ? { ...wert, texte: [...wert.texte, neu] } : wert));
    setGewaehlterText(id);
    setWerkzeug('text');
  }

  const aktiverText = useMemo(
    () => doc?.texte.find((text) => text.id === gewaehlterText) ?? null,
    [doc, gewaehlterText],
  );

  function textAendern(aenderung: Partial<Schriftzug>) {
    if (!aktiverText) return;
    setDoc((wert) =>
      wert
        ? {
            ...wert,
            texte: wert.texte.map((text) =>
              text.id === aktiverText.id ? { ...text, ...aenderung } : text,
            ),
          }
        : wert,
    );
  }

  function textLoeschen() {
    if (!aktiverText) return;
    merken();
    setDoc((wert) =>
      wert ? { ...wert, texte: wert.texte.filter((text) => text.id !== aktiverText.id) } : wert,
    );
    setGewaehlterText(null);
  }

  /* ---------- Speichern ---------- */

  async function ergebnis(): Promise<{ blob: Blob; name: string } | null> {
    if (!bild || !doc) return null;
    const canvas = zeichneAusgabe(bild, bild.naturalWidth, bild.naturalHeight, doc);
    // WebP ist bei gleicher Güte deutlich kleiner; ältere Geräte, die es nicht
    // schreiben können, bekommen still JPEG – `toBlob` sagt im `type` des
    // Ergebnisses, was daraus geworden ist.
    const blob = await new Promise<Blob | null>((auf) =>
      canvas.toBlob((wert) => auf(wert), 'image/webp', 0.92),
    );
    const fertig =
      blob ??
      (await new Promise<Blob | null>((auf) =>
        canvas.toBlob((wert) => auf(wert), 'image/jpeg', 0.92),
      ));
    if (!fertig) {
      toast('Das bearbeitete Bild konnte nicht erzeugt werden.', 'error');
      return null;
    }
    const endung = fertig.type === 'image/webp' ? 'webp' : 'jpg';
    return { blob: fertig, name: bearbeiteterName(name, endung) };
  }

  async function aufsHandy() {
    setSpeichert(true);
    try {
      const fertig = await ergebnis();
      if (!fertig) return;
      const url = URL.createObjectURL(fertig.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fertig.name;
      document.body.append(link);
      link.click();
      link.remove();
      // Erst freigeben, wenn der Browser den Download angefasst hat.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setSpeichert(false);
    }
  }

  async function inDieApp() {
    if (!onFertig) return;
    setSpeichert(true);
    try {
      const fertig = await ergebnis();
      if (!fertig) return;
      await onFertig(fertig.blob, fertig.name);
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  const unberuehrt = bild && doc ? docUnberuehrt(doc, bild.naturalWidth, bild.naturalHeight) : true;

  return createPortal(
    <div className="bild-editor" role="dialog" aria-modal="true" aria-label="Bild bearbeiten">
      <header className="bild-kopf">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
        <strong className="truncate">Bild bearbeiten</strong>
        <button
          type="button"
          className="icon-btn"
          onClick={zurueck}
          disabled={!kannZurueck}
          aria-label="Rückgängig"
        >
          ↺
        </button>
      </header>

      <div className="bild-buehne">
        {laedt && <p className="bild-hinweis">Bild wird geladen …</p>}
        <canvas
          ref={canvasRef}
          className="bild-leinwand"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        />
      </div>

      <div className="bild-panel">
        {werkzeug === 'zuschnitt' && (
          <>
            <div className="bild-reihe">
              <button type="button" className="btn btn-sm" onClick={() => drehen(-1)}>
                ↺ Links
              </button>
              <button type="button" className="btn btn-sm" onClick={() => drehen(1)}>
                ↻ Rechts
              </button>
              <button type="button" className="btn btn-sm" onClick={spiegeln}>
                ⇄ Spiegeln
              </button>
              <button type="button" className="btn btn-sm" onClick={zuschnittGanz}>
                Ganzes Bild
              </button>
            </div>
            <div className="bild-reihe">
              {VERHAELTNISSE.map((eintrag) => (
                <button
                  key={eintrag.label}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => verhaeltnisSetzen(eintrag.wert)}
                  disabled={eintrag.wert === null}
                  title={
                    eintrag.wert === null
                      ? 'Ziehe die Ecken – ohne festes Verhältnis.'
                      : `Auf ${eintrag.label} zuschneiden`
                  }
                >
                  {eintrag.label}
                </button>
              ))}
            </div>
            <p className="bild-hinweis">
              Zieh an den Ecken oder Kanten. Innerhalb des Rahmens verschiebst du den Ausschnitt.
            </p>
          </>
        )}

        {werkzeug === 'malen' && (
          <>
            <div className="bild-farben">
              {FARBEN.map((wert) => (
                <button
                  key={wert}
                  type="button"
                  className={`bild-farbe ${farbe === wert ? 'is-active' : ''}`}
                  style={{ background: wert }}
                  onClick={() => setFarbe(wert)}
                  aria-label={`Farbe ${wert}`}
                />
              ))}
            </div>
            <label className="bild-schieber">
              <span>Strich</span>
              <input
                type="range"
                min={2}
                max={80}
                value={breite}
                onChange={(event) => setBreite(Number(event.target.value))}
              />
              <span className="bild-wert">{breite}</span>
            </label>
            <div className="bild-reihe">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  merken();
                  setDoc((wert) => (wert ? { ...wert, striche: wert.striche.slice(0, -1) } : wert));
                }}
                disabled={!doc || doc.striche.length === 0}
              >
                Letzten Strich zurück
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  merken();
                  setDoc((wert) => (wert ? { ...wert, striche: [] } : wert));
                }}
                disabled={!doc || doc.striche.length === 0}
              >
                Alles wegwischen
              </button>
            </div>
            <p className="bild-hinweis">
              Der Strich klebt am Bild: Drehst du später, dreht er mit.
            </p>
          </>
        )}

        {werkzeug === 'text' && (
          <>
            <div className="bild-reihe">
              <button type="button" className="btn btn-sm" onClick={textHinzufuegen}>
                ＋ Schriftzug
              </button>
              {doc?.texte.map((text) => (
                <button
                  key={text.id}
                  type="button"
                  className={`btn btn-sm ${text.id === gewaehlterText ? 'is-active' : ''}`}
                  onClick={() => setGewaehlterText(text.id)}
                >
                  {text.text.split('\n')[0].slice(0, 12) || '(leer)'}
                </button>
              ))}
            </div>
            {aktiverText ? (
              <>
                <textarea
                  className="bild-textfeld"
                  rows={2}
                  value={aktiverText.text}
                  onChange={(event) => textAendern({ text: event.target.value })}
                  placeholder="Was soll draufstehen?"
                />
                <div className="bild-reihe">
                  {SCHRIFTEN.map((schrift) => (
                    <button
                      key={schrift.key}
                      type="button"
                      className={`btn btn-sm ${aktiverText.schrift === schrift.key ? 'is-active' : ''}`}
                      style={{ fontFamily: schrift.stack }}
                      onClick={() => textAendern({ schrift: schrift.key })}
                    >
                      {schrift.label}
                    </button>
                  ))}
                </div>
                <div className="bild-farben">
                  {FARBEN.map((wert) => (
                    <button
                      key={wert}
                      type="button"
                      className={`bild-farbe ${aktiverText.farbe === wert ? 'is-active' : ''}`}
                      style={{ background: wert }}
                      onClick={() => textAendern({ farbe: wert })}
                      aria-label={`Schriftfarbe ${wert}`}
                    />
                  ))}
                </div>
                <div className="bild-reihe">
                  <button
                    type="button"
                    className={`btn btn-sm ${aktiverText.fett ? 'is-active' : ''}`}
                    onClick={() => textAendern({ fett: !aktiverText.fett })}
                  >
                    <strong>F</strong> Fett
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${aktiverText.kontur ? 'is-active' : ''}`}
                    onClick={() =>
                      textAendern({
                        kontur: aktiverText.kontur
                          ? null
                          : aktiverText.farbe === '#111111'
                            ? '#ffffff'
                            : '#111111',
                      })
                    }
                    title="Eine Kontur hält die Schrift auch über unruhigem Bild lesbar."
                  >
                    ◌ Kontur {aktiverText.kontur ? 'an' : 'aus'}
                  </button>
                  {aktiverText.kontur && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        textAendern({
                          kontur: aktiverText.kontur === '#111111' ? '#ffffff' : '#111111',
                        })
                      }
                    >
                      Kontur {aktiverText.kontur === '#111111' ? 'dunkel' : 'hell'}
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" onClick={textLoeschen}>
                    🗑 Löschen
                  </button>
                </div>
                <label className="bild-schieber">
                  <span>Größe</span>
                  <input
                    type="range"
                    min={Math.max(8, Math.round(aktiverText.groesse / 8))}
                    max={Math.round(
                      Math.max(bild?.naturalWidth ?? 512, bild?.naturalHeight ?? 512) / 3,
                    )}
                    value={aktiverText.groesse}
                    onChange={(event) => textAendern({ groesse: Number(event.target.value) })}
                  />
                  <span className="bild-wert">{aktiverText.groesse}</span>
                </label>
                <p className="bild-hinweis">
                  Tipp ins Bild, um den Schriftzug dorthin zu setzen – oder zieh ihn an seinen Platz.
                </p>
              </>
            ) : (
              <p className="bild-hinweis">
                Noch kein Schriftzug. „＋ Schriftzug“ legt einen in der Bildmitte an.
              </p>
            )}
          </>
        )}
      </div>

      <div className="bild-fuss">
        <div className="bild-reiter">
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'zuschnitt' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('zuschnitt')}
          >
            <span aria-hidden="true">✂️</span> Zuschnitt
          </button>
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'malen' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('malen')}
          >
            <span aria-hidden="true">✏️</span> Malen
          </button>
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'text' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('text')}
          >
            <span aria-hidden="true">🅣</span> Text
          </button>
        </div>
        {/* Gibt es keinen Ablageort in der App, ist „aufs Handy“ nicht die
            zweite Wahl, sondern die einzige – dann steht sie auch dort, wo man
            sie sucht, statt neben einem gesperrten Knopf. */}
        <div className="bild-reihe">
          <button
            type="button"
            className={onFertig ? 'btn btn-sm' : 'btn btn-primary'}
            onClick={() => void aufsHandy()}
            disabled={laedt || speichert}
          >
            ⬇ Aufs Handy {onFertig ? '' : 'speichern'}
          </button>
          {onFertig && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void inDieApp()}
              disabled={laedt || speichert}
            >
              {speichert ? '…' : (zielName ?? 'Als neue Datei sichern')}
            </button>
          )}
        </div>
        {unberuehrt && !laedt && (
          <p className="bild-hinweis">
            Noch nichts geändert – gespeichert würde eine Kopie des Originals.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
