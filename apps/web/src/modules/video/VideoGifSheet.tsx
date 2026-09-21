import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Sheet } from '../../components/Sheet.js';
import { Streifen } from './Streifen.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from '../media/helpers.js';
import { AbbruchError } from '../stickers/engines/index.js';
import {
  BILDRATEN,
  BILDRATE_VORGABE,
  groesseSchaetzenB,
  groesseText,
  zeitpunkte,
} from './ausschnitt.js';
import { masse, videoBilderLesen } from './bilderLesen.js';
import { tippNetzVerfuegbar } from '../bild/tippMaske.js';
import { TOLERANZ_VORGABE } from '../bild/doc.js';
import {
  GUETE_VORGABE,
  MAX_BILDER,
  VIDEO_GUETEN,
  dauerSchaetzenMs,
  dauerText,
  gueteFinden,
  gueteMoeglich,
  readVideoGuete,
  writeVideoGuete,
  type VideoGuete,
} from './einstellungen.js';
import {
  ABSCHNITT_TITEL,
  BauAbbruch,
  VOLLBILD_KANTE,
  gifAusVideo,
  type Abschnitt,
} from './gifBauen.js';

/**
 * Aus einem Video ein GIF machen.
 *
 * # Warum die Auswahl auf einem Filmstreifen sitzt und nicht auf einer Leiste
 *
 * Weil niemand weiss, was bei Sekunde 4,2 passiert. Eine Zeitleiste mit zwei
 * Griffen ist schnell gebaut und zwingt dazu, blind zu schieben und immer
 * wieder vorzuhören. Acht Standbilder darunter beantworten dieselbe Frage auf
 * einen Blick.
 *
 * # Warum die Tipps als ANTEILE gemerkt werden und nicht in Bildpunkten
 *
 * Weil die Rechengrösse von der gewählten Güte abhängt – 320 bei „Schnell",
 * 512 bei „Sehr genau". Ein in Punkten gemerkter Tipp sässe nach einem
 * Wechsel der Güte woanders, und zwar ohne dass irgendetwas danach aussähe.
 */

/** Wie viele Standbilder der Filmstreifen zeigt. */
const STREIFEN = 8;
/** Die Kante der Standbilder. Klein genug, dass acht davon in Sekunden da sind. */
const STREIFEN_KANTE = 96;

interface Tipp {
  /** 0…1, bezogen auf Breite und Höhe des Bildes. */
  readonly ax: number;
  readonly ay: number;
  readonly dazu: boolean;
}

interface Lauf {
  readonly anteil: number;
  readonly abschnitt: Abschnitt;
  readonly text: string;
}

/** Ein Bildschirm, der beim Rechnen nicht ausgehen soll – falls der Browser mitspielt. */
interface Wachposten {
  release(): Promise<void>;
}

export function VideoGifSheet({
  video,
  name,
  onFertig,
  alsSticker,
  stickerText = '😀 Als Sticker speichern',
  stickerGrenzeBytes,
  onClose,
  zielName = 'In den Chat',
}: {
  video: Blob;
  name?: string;
  /** Wohin das fertige GIF gehört. Fehlt es, bleibt nur das Speichern aufs Gerät. */
  onFertig?: (blob: Blob, dateiname: string) => Promise<void> | void;
  /**
   * Der zweite Ausgang: in ein Sticker-Paket.
   *
   * Die Masse gehen mit, und das ist kein Beiwerk. Ein Sticker aus dem Studio
   * ist immer 512 × 512; ein GIF aus einem Video hat das Seitenverhältnis des
   * Films. Die Zahlen landen unverändert in `stickers.width`/`stickers.height`
   * – wer dort 512 × 512 einträgt, lügt die Datenbank an.
   *
   * Als Rückweg und nicht als eingebautes Blatt, weil dieses Modul sonst die
   * halbe Sticker-Welt mitzöge: Sitzung, Paketliste, Hochladen. Der Aufrufer
   * hat die ohnehin.
   */
  alsSticker?: (blob: Blob, breite: number, hoehe: number) => void;
  /**
   * Was auf dem Sticker-Knopf steht.
   *
   * Das GIF geht je nach Aufrufer woandershin: aus der Werkstatt heraus
   * gleich in ein Paket, aus dem Studio heraus zurück auf die Leinwand. „Als
   * Sticker speichern“ wäre im zweiten Fall schlicht falsch – gespeichert
   * wird dort erst später.
   */
  stickerText?: string;
  /**
   * Ab wann der Sticker-Weg gar nicht erst angeboten wird.
   *
   * Nur für Aufrufer, bei denen das GIF UNVERÄNDERT hochgeladen wird – dort
   * zieht `maxUploadBytes.sticker` die Grenze, und ein Knopf, der sicher in
   * eine Absage führt, ist schlimmer als keiner. Wer das GIF danach noch
   * einmal anfasst (das Studio rechnet es auf 512 × 512 herunter), lässt das
   * hier weg: Dort wäre die Grenze eine Erfindung.
   */
  stickerGrenzeBytes?: number;
  onClose: () => void;
  zielName?: string;
}) {
  const [dauerMs, setDauerMs] = useState(0);
  const [streifen, setStreifen] = useState<{ zeitMs: number; bild: string }[]>([]);
  /** Die Masse des Videos selbst – der Filmstreifen kommt viel kleiner. */
  const [quelle, setQuelle] = useState<{ b: number; h: number } | null>(null);
  const [vonMs, setVonMs] = useState(0);
  const [bisMs, setBisMs] = useState(0);
  const [bildrate, setBildrate] = useState<number>(BILDRATE_VORGABE);
  const [guete, setGuete] = useState<VideoGuete>(() => readVideoGuete());
  const [freistellen, setFreistellen] = useState(false);
  const [tipps, setTipps] = useState<Tipp[]>([]);
  const [tippMinus, setTippMinus] = useState(false);
  /**
   * Ob die Tipps durch das TIPPNETZ gehen oder nach Farbe fluten.
   *
   * Dieselbe Wahl wie im Sticker-Studio. Vorbelegt mit dem, was geht: Ist das
   * Tippnetz auf diesem Gerät abgeschaltet, stünde ein Haken da, der beim
   * Antippen in eine Fehlermeldung liefe.
   */
  const [tippMitNetz, setTippMitNetz] = useState(() => tippNetzVerfuegbar());
  const [toleranz, setToleranz] = useState(TOLERANZ_VORGABE);
  /**
   * Das Bild, auf das getippt wird – genau bei `vonMs`.
   *
   * Nicht das nächstgelegene Standbild aus dem Streifen: Der zeigt bei einem
   * Video von zwanzig Sekunden alle zweieinhalb Sekunden eines, und so weit
   * ist eine gehende Person längst woanders. Getippt würde dann auf den
   * Hintergrund, und das Netz fände dort auch etwas – nur nicht das Gemeinte.
   */
  const [anfangsbild, setAnfangsbild] = useState<string | null>(null);
  const [grafikTauglich, setGrafikTauglich] = useState(false);
  const [lauf, setLauf] = useState<Lauf | null>(null);
  const [ergebnis, setErgebnis] = useState<{
    url: string;
    blob: Blob;
    text: string;
    breite: number;
    hoehe: number;
  } | null>(null);
  const [nachAbbruch, setNachAbbruch] = useState<number | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const steuerung = useRef<AbortController | null>(null);
  const wache = useRef<Wachposten | null>(null);

  const info = gueteFinden(guete);
  const machbar = gueteMoeglich(info, grafikTauglich);

  /* ---------- Die Grafikeinheit prüfen ---------- */

  useEffect(() => {
    let gilt = true;
    void import('../stickers/engines/ort-laufzeit.js')
      .then((modul) => modul.laufzeitEntscheiden())
      .then((laufzeit) => {
        if (gilt) setGrafikTauglich(laufzeit.taugt);
      })
      .catch(() => {
        // Schlägt schon die Prüfung fehl, bleibt es bei „keine Grafikeinheit“ –
        // das ist die sichere Annahme, nicht die bequeme.
      });
    return () => {
      gilt = false;
    };
  }, []);

  /* ---------- Den Filmstreifen holen ---------- */

  useEffect(() => {
    let gilt = true;
    const abbruch = new AbortController();
    const adressen: string[] = [];

    void (async () => {
      try {
        /*
         * Erst EIN Bild bei null holen – nur, um Länge und Masse zu erfahren.
         * `videoBilderLesen` sucht dabei auch die Länge einer Aufnahme aus
         * dieser App, bei der sie im Kopf fehlt.
         */
        const erst = await videoBilderLesen(video, {
          zeitpunkte: [0],
          kante: STREIFEN_KANTE,
          abbruch: abbruch.signal,
        });
        if (!gilt) return;
        setDauerMs(erst.dauerMs);
        setQuelle({ b: erst.quellBreite, h: erst.quellHoehe });
        setBisMs(Math.min(erst.dauerMs, 3000));

        const marken = Array.from({ length: STREIFEN }, (_, i) =>
          Math.round((erst.dauerMs * i) / STREIFEN),
        );
        const alle = await videoBilderLesen(video, {
          zeitpunkte: marken,
          kante: STREIFEN_KANTE,
          abbruch: abbruch.signal,
        });
        if (!gilt) return;

        const flaeche = document.createElement('canvas');
        flaeche.width = alle.breite;
        flaeche.height = alle.hoehe;
        const stift = flaeche.getContext('2d');
        const bilder = alle.bilder.map((bild) => {
          stift?.putImageData(bild.daten, 0, 0);
          const url = flaeche.toDataURL('image/webp', 0.7);
          adressen.push(url);
          return { zeitMs: bild.zeitMs, bild: url };
        });
        setStreifen(bilder);
      } catch (ausfall) {
        if (!gilt || ausfall instanceof AbbruchError) return;
        toast(errorMessage(ausfall, 'Dieses Video lässt sich nicht lesen'), 'error');
        onClose();
      }
    })();

    return () => {
      gilt = false;
      abbruch.abort();
    };
    // `onClose` bewusst draussen: Es ist bei jedem Aufrufer eine frische
    // Funktion und würde den Streifen bei jedem Rendern neu holen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  /*
   * Die Masse, in denen wirklich gerechnet wird.
   *
   * Sie hängen an der GÜTE – 320 bei „Schnell", 512 bei „Sehr genau". Deshalb
   * werden die Tipps als Anteile gemerkt und erst hier in Punkte umgerechnet:
   * Ein Wechsel der Güte verschiebt sonst jeden gesetzten Tipp.
   */
  /*
   * Die Kante, in der wirklich gerechnet wird.
   *
   * Mit Freistellen die der Güte – dort hängt die Kante der Maske daran, und
   * bei BiRefNet sind es zwingend 512. Ohne Freistellen läuft kein Netz, und
   * dann hat die Güte nichts mehr zu sagen: siehe `VOLLBILD_KANTE`.
   */
  const rechenKante = freistellen ? info.kante : VOLLBILD_KANTE;
  const masseBild = quelle ? masse(quelle.b, quelle.h, rechenKante) : null;

  /* ---------- Das Bild zum Antippen ---------- */

  useEffect(() => {
    if (!freistellen || dauerMs === 0) {
      setAnfangsbild(null);
      return undefined;
    }
    let gilt = true;
    const abbruch = new AbortController();
    /*
     * Ein Viertelsekunde Ruhe abwarten.
     *
     * Am Griff wird gezogen, nicht getippt – ohne diese Pause löste jede
     * Zwischenstellung einen Sprung im Video aus, und bei gemessenen 75 ms je
     * Sprung stapelten sich die Anfragen schneller, als sie abgearbeitet
     * werden.
     */
    const uhr = window.setTimeout(() => {
      void (async () => {
        try {
          const gelesen = await videoBilderLesen(video, {
            zeitpunkte: [vonMs],
            kante: 320,
            abbruch: abbruch.signal,
          });
          if (!gilt) return;
          const flaeche = document.createElement('canvas');
          flaeche.width = gelesen.breite;
          flaeche.height = gelesen.hoehe;
          flaeche.getContext('2d')?.putImageData(gelesen.bilder[0].daten, 0, 0);
          setAnfangsbild(flaeche.toDataURL('image/webp', 0.8));
        } catch {
          // Klappt es nicht, bleibt das Standbild aus dem Streifen – ungenau,
          // aber besser als eine leere Fläche.
        }
      })();
    }, 250);
    return () => {
      gilt = false;
      window.clearTimeout(uhr);
      abbruch.abort();
    };
  }, [freistellen, vonMs, dauerMs, video]);

  /* ---------- Was dabei herauskommt ---------- */

  const plan = useMemo(
    () => zeitpunkte(vonMs, bisMs, bildrate, MAX_BILDER),
    [vonMs, bisMs, bildrate],
  );
  const anzahl = plan.zeitpunkte.length;
  const bytes = groesseSchaetzenB(anzahl, rechenKante, freistellen);
  const dauer = dauerSchaetzenMs(anzahl, info, freistellen, rechenKante);

  /* ---------- Rechnen ---------- */

  const wachePruefen = useCallback(async (an: boolean) => {
    /*
     * Der Bildschirm soll beim Rechnen nicht ausgehen – aber NIE als
     * Voraussetzung. Ein Browser ohne `wakeLock`, ein abgelehntes Recht, ein
     * Tab im Hintergrund: Alles davon ist erlaubt, und das GIF entsteht
     * trotzdem. Deshalb steht hier nirgends ein `throw`.
     */
    type MitWache = Navigator & { wakeLock?: { request(art: 'screen'): Promise<Wachposten> } };
    const zugang = (navigator as MitWache).wakeLock;
    if (an) {
      if (!zugang) return;
      try {
        wache.current = await zugang.request('screen');
      } catch {
        wache.current = null;
      }
      return;
    }
    try {
      await wache.current?.release();
    } catch {
      /* schon weg – dann ist ja gut */
    }
    wache.current = null;
  }, []);

  const starten = useCallback(
    async (bisJetzt?: number) => {
      if (lauf) return;
      setNachAbbruch(null);
      const steuer = new AbortController();
      steuerung.current = steuer;
      setLauf({ anteil: 0, abschnitt: 'lesen', text: 'Bilder holen …' });
      await wachePruefen(true);
      try {
        const ende = bisJetzt === undefined ? bisMs : vonMs + bisJetzt * plan.dauerJeBildMs;
        const fertig = await gifAusVideo({
          datei: video,
          vonMs,
          bisMs: ende,
          bildrate,
          guete: info,
          freistellen,
          tipps:
            freistellen && masseBild
              ? tipps.map((tipp) => ({
                  x: Math.round(tipp.ax * masseBild.b),
                  y: Math.round(tipp.ay * masseBild.h),
                  dazu: tipp.dazu,
                }))
              : undefined,
          mitNetz: tippMitNetz,
          toleranz,
          fortschritt: (anteil, abschnitt, text) => setLauf({ anteil, abschnitt, text }),
          abbruch: steuer.signal,
        });
        setErgebnis({
          url: URL.createObjectURL(fertig.blob),
          blob: fertig.blob,
          breite: fertig.breite,
          hoehe: fertig.hoehe,
          text: `${fertig.bilder} Bilder · ${fertig.breite} × ${fertig.hoehe} · ${groesseText(
            fertig.blob.size,
          )}`,
        });
      } catch (ausfall) {
        if (ausfall instanceof BauAbbruch) {
          // Die Arbeit ist nicht weg – sie steht nur nicht mehr in der Zukunft.
          setNachAbbruch(ausfall.fertigeBilder >= 2 ? ausfall.fertigeBilder : null);
        } else if (!(ausfall instanceof AbbruchError)) {
          toast(errorMessage(ausfall, 'Das GIF ging nicht'), 'error');
        }
      } finally {
        await wachePruefen(false);
        steuerung.current = null;
        setLauf(null);
      }
    },
    [
      bildrate,
      bisMs,
      freistellen,
      info,
      lauf,
      masseBild,
      plan.dauerJeBildMs,
      tipps,
      video,
      vonMs,
      wachePruefen,
    ],
  );

  useEffect(
    () => () => {
      steuerung.current?.abort();
      void wachePruefen(false);
    },
    [wachePruefen],
  );

  useEffect(() => {
    if (!ergebnis) return undefined;
    return () => URL.revokeObjectURL(ergebnis.url);
  }, [ergebnis]);

  const dateiname = `${(name ?? 'video').replace(/\.[^.]+$/, '')}.gif`;

  /* ---------- Das Bild ---------- */

  if (ergebnis) {
    return (
      <Sheet open onClose={onClose} title="Fertig">
        <div className="vg-ergebnis">
          <img src={ergebnis.url} alt="Das fertige GIF" className="vg-vorschau" />
          <p className="vg-hinweis">{ergebnis.text}</p>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={() => setErgebnis(null)}
            >
              Noch einmal
            </button>
            {onFertig && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={speichert}
                onClick={() => {
                  setSpeichert(true);
                  void Promise.resolve(onFertig(ergebnis.blob, dateiname))
                    .then(() => onClose())
                    .catch((ausfall: unknown) =>
                      toast(errorMessage(ausfall, 'Das Speichern ging nicht'), 'error'),
                    )
                    .finally(() => setSpeichert(false));
                }}
              >
                {speichert ? '…' : zielName}
              </button>
            )}
          </div>
          {alsSticker &&
            (stickerGrenzeBytes === undefined || ergebnis.blob.size <= stickerGrenzeBytes ? (
              <button
                type="button"
                className="btn btn-block"
                onClick={() => alsSticker(ergebnis.blob, ergebnis.breite, ergebnis.hoehe)}
              >
                {stickerText}
              </button>
            ) : (
              /*
               * Statt eines Knopfes, der in eine Fehlermeldung führt.
               *
               * Ein Sticker darf höchstens so viel wiegen wie
               * `maxUploadBytes.sticker`; ein GIF in voller Breite reisst das
               * bei ein paar Sekunden mühelos. Den Weg trotzdem anzubieten
               * hiesse, jemanden durch Paketwahl und Emoji zu schicken, damit
               * der Server am Ende ablehnt – und die Meldung von dort sagt
               * nicht, was zu ändern wäre.
               */
              <p className="vg-hinweis">
                Für ein Sticker-Paket ist dieses GIF zu schwer – {groesseText(ergebnis.blob.size)}{' '}
                gegen erlaubte {groesseText(stickerGrenzeBytes)}. Nimm einen kürzeren Ausschnitt
                oder weniger Bilder je Sekunde; am meisten bringt „Freistellen“.
              </p>
            ))}
          <a className="btn btn-ghost" href={ergebnis.url} download={dateiname}>
            Auf das Gerät speichern
          </a>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} title="GIF aus Video">
      <div className="stack">
        {streifen.length === 0 ? (
          <p className="vg-hinweis">
            <span className="spinner" aria-hidden="true" /> Das Video wird durchgesehen …
          </p>
        ) : (
          <>
            <Streifen
              bilder={streifen}
              dauerMs={dauerMs}
              vonMs={vonMs}
              bisMs={bisMs}
              gesperrt={lauf !== null}
              onBereich={(von, bis) => {
                setVonMs(von);
                setBisMs(bis);
              }}
            />
            <p className="vg-hinweis">
              {anzahl} {anzahl === 1 ? 'Bild' : 'Bilder'} · {groesseText(bytes)} ·{' '}
              {dauerText(dauer)}
              {plan.gekuerztMs > 0 && (
                <>
                  {' '}
                  <strong>
                    Hinten fallen {(plan.gekuerztMs / 1000).toFixed(1).replace('.', ',')} s weg –
                    mehr als {MAX_BILDER} Bilder gibt es nicht.
                  </strong>
                </>
              )}
            </p>
          </>
        )}

        <fieldset className="vg-gruppe" disabled={lauf !== null}>
          <legend>Bilder je Sekunde</legend>
          <div className="vg-kacheln">
            {BILDRATEN.map((rate) => (
              <button
                key={rate.rate}
                type="button"
                className={`vg-kachel${rate.rate === bildrate ? ' ist-aktiv' : ''}`}
                onClick={() => setBildrate(rate.rate)}
                title={rate.beschreibung}
              >
                {rate.titel}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="vg-gruppe" disabled={lauf !== null}>
          <legend>Freistellen</legend>
          <label className="vg-schalter">
            <input
              type="checkbox"
              checked={freistellen}
              onChange={(ereignis) => setFreistellen(ereignis.target.checked)}
            />
            <span>
              Person oder Motiv vom Hintergrund trennen
              <small>Macht die Datei um ein Vielfaches kleiner – und dauert deutlich länger.</small>
            </span>
          </label>

          {freistellen && (
            <>
              <div className="vg-kacheln">
                {VIDEO_GUETEN.map((stufe) => {
                  const moeglich = gueteMoeglich(stufe, grafikTauglich).moeglich;
                  return (
                    <button
                      key={stufe.key}
                      type="button"
                      className={`vg-kachel vg-kachel-breit${stufe.key === guete ? ' ist-aktiv' : ''}${
                        moeglich ? '' : ' ist-aus'
                      }`}
                      onClick={() => {
                        setGuete(stufe.key);
                        writeVideoGuete(stufe.key);
                      }}
                    >
                      <strong>{stufe.titel}</strong>
                      <small>{stufe.beschreibung}</small>
                    </button>
                  );
                })}
              </div>
              {!machbar.moeglich && <p className="vg-absage">{machbar.grund}</p>}
              {streifen.length > 0 && (
                <Antippen
                  bild={anfangsbild ?? streifen[naechsterStreifen(streifen, vonMs)].bild}
                  genau={anfangsbild !== null}
                  tipps={tipps}
                  minus={tippMinus}
                  onTipp={(tipp) => setTipps((alt) => [...alt, tipp])}
                  onZurueck={() => setTipps((alt) => alt.slice(0, -1))}
                  onMinus={setTippMinus}
                  mitNetz={tippMitNetz}
                  netzGeht={tippNetzVerfuegbar()}
                  onMitNetz={setTippMitNetz}
                  toleranz={toleranz}
                  onToleranz={setToleranz}
                />
              )}
            </>
          )}
        </fieldset>

        {lauf && (
          <div className="stk-lauf">
            <strong>{ABSCHNITT_TITEL[lauf.abschnitt]}</strong>
            <div
              className="stk-balken"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(lauf.anteil * 100)}
            >
              <span style={{ width: `${Math.round(lauf.anteil * 100)}%` }} />
            </div>
            <span className="vg-hinweis">{lauf.text}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => steuerung.current?.abort()}
            >
              Abbrechen
            </button>
          </div>
        )}

        {nachAbbruch !== null && !lauf && (
          <div className="vg-nachfrage">
            <p>
              Abgebrochen – {nachAbbruch} Bilder waren schon fertig. Daraus trotzdem ein GIF machen?
            </p>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn" onClick={() => setNachAbbruch(null)}>
                Nein
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void starten(nachAbbruch)}
              >
                Ja, aus {nachAbbruch} Bildern
              </button>
            </div>
          </div>
        )}

        {!lauf && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={streifen.length === 0 || anzahl === 0 || (freistellen && !machbar.moeglich)}
            onClick={() => void starten()}
          >
            GIF bauen
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Welches Standbild dem Anfang am nächsten liegt. */
function naechsterStreifen(bilder: { zeitMs: number }[], vonMs: number): number {
  let beste = 0;
  for (let i = 1; i < bilder.length; i += 1) {
    if (Math.abs(bilder[i].zeitMs - vonMs) < Math.abs(bilder[beste].zeitMs - vonMs)) beste = i;
  }
  return beste;
}

/* ---------- Antippen im ersten Bild ---------- */

function Antippen({
  bild,
  genau,
  tipps,
  minus,
  onTipp,
  onZurueck,
  onMinus,
  mitNetz,
  netzGeht,
  onMitNetz,
  toleranz,
  onToleranz,
}: {
  bild: string;
  /** Ob das Bild wirklich vom Anfang kommt oder nur das nächstgelegene ist. */
  genau: boolean;
  tipps: Tipp[];
  minus: boolean;
  onTipp: (tipp: Tipp) => void;
  onZurueck: () => void;
  onMinus: (minus: boolean) => void;
  mitNetz: boolean;
  /** Ob das Tippnetz auf diesem Gerät überhaupt eingeschaltet ist. */
  netzGeht: boolean;
  onMitNetz: (mitNetz: boolean) => void;
  toleranz: number;
  onToleranz: (toleranz: number) => void;
}) {
  return (
    <div className="vg-antippen">
      <p className="vg-hinweis">
        Tipp an, was bleiben soll. Die Stelle wandert mit dem Bild mit – ein Tipp auf eine Person
        bleibt auf ihr, auch wenn sie sich bewegt.
        {!genau && ' Das Bild wird noch geholt …'}
      </p>
      <button
        type="button"
        className="vg-tippflaeche"
        onClick={(ereignis) => {
          const kasten = ereignis.currentTarget.getBoundingClientRect();
          onTipp({
            ax: (ereignis.clientX - kasten.left) / kasten.width,
            ay: (ereignis.clientY - kasten.top) / kasten.height,
            dazu: !minus,
          });
        }}
      >
        <img src={bild} alt="Erstes Bild des Ausschnitts" />
        {tipps.map((tipp, i) => (
          <span
            key={`${tipp.ax}-${tipp.ay}-${i}`}
            className={`vg-punkt${tipp.dazu ? '' : ' ist-weg'}`}
            style={{ left: `${tipp.ax * 100}%`, top: `${tipp.ay * 100}%` }}
          />
        ))}
      </button>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className={`btn${minus ? '' : ' btn-primary'}`}
          style={{ flex: 1 }}
          onClick={() => onMinus(false)}
        >
          ＋ dazu
        </button>
        <button
          type="button"
          className={`btn${minus ? ' btn-primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => onMinus(true)}
        >
          − weg
        </button>
        <button type="button" className="btn" onClick={onZurueck} disabled={tipps.length === 0}>
          ↶
        </button>
      </div>
      <label className="vg-schalter">
        <input
          type="checkbox"
          checked={mitNetz}
          disabled={!netzGeht}
          onChange={(ereignis) => onMitNetz(ereignis.target.checked)}
        />
        <span>
          Mit Netz
          <small>
            {netzGeht
              ? 'Trifft ein Ding als Ganzes. Ohne Haken wird genommen, was farblich zusammenhängt – das geht auch bei einem Schatten an der Wand.'
              : '„Antippen mit Netz“ ist auf diesem Gerät abgeschaltet. Getippt wird deshalb nach Farbe; einschalten lässt es sich unter „Aussehen“.'}
          </small>
        </span>
      </label>
      {!mitNetz && (
        /*
         * Die Toleranz gibt es nur ohne Netz – mit Netz hat sie keine
         * Bedeutung, und ein Regler, der nichts tut, ist schlimmer als keiner.
         *
         * Sie ist hier kein Feinschliff: Auf einer glatten Fläche verschluckt
         * schon eine kleine Toleranz das ganze Ding, auf einem körnigen Grund
         * reicht auch eine grosse nicht über den Rand. Ohne Regler wäre das
         * Antippen nach Farbe eine Wette.
         */
        <label className="vg-regler">
          <span>Toleranz {toleranz}</span>
          <input
            type="range"
            min={4}
            max={96}
            step={4}
            value={toleranz}
            onChange={(ereignis) => onToleranz(Number(ereignis.target.value))}
          />
        </label>
      )}
    </div>
  );
}
