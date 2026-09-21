import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Sheet } from '../../components/Sheet.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from '../media/helpers.js';
import { BildEditor } from '../bild/BildEditor.js';
import { docUnberuehrt, type BildDoc } from '../bild/doc.js';
import { AbbruchError } from '../stickers/engines/index.js';
import {
  FILM_BILDRATEN,
  FILM_BILDRATE_VORGABE,
  filmSchrittMs,
  filmZeitpunkte,
  type Stueck,
} from './ausschnitt.js';
import { masse, videoBilderLesen } from './bilderLesen.js';
import { hatFormTeile, inhaltsTeile } from './bildweise.js';
import {
  MAX_BILDER_FILM,
  dauerText,
  filmDauerSchaetzenMs,
  maxBilderFuer,
} from './einstellungen.js';
import { Streifen } from './Streifen.js';
import { videoTauglich } from './schreiben.js';
import { ABSCHNITT_TITEL, VideoBauAbbruch, videoAusVideo, type Abschnitt } from './videoBauen.js';

/**
 * Videobearbeitung – derselbe Editor wie beim Foto, über alle Bilder.
 *
 * # Warum an EINEM Bild eingestellt wird
 *
 * Weil eine Bearbeitung eine Entscheidung ist. „Etwas wärmer, den Himmel
 * dunkler" gilt für den ganzen Film; an fünfzig Bildern einzeln eingestellt
 * wären es fünfzig Mal dieselbe Entscheidung mit fünfzig leicht verschiedenen
 * Ergebnissen – und ein flackernder Film.
 *
 * Eingestellt wird am ERSTEN Bild des gewählten Ausschnitts. Nicht an einem
 * mittleren: Wer den Anfang wählt, sieht beim Einstellen genau das, was er
 * eben im Streifen angesehen hat.
 *
 * # Warum die Rechengrösse gewählt wird
 *
 * Weil alle Bilder unkomprimiert im Speicher liegen. Hundertfünfzig Bilder
 * bei 1280 × 720 sind 553 MB – dafür wirft ein Telefon den Reiter weg, ohne
 * dass irgendwo eine Fehlermeldung ankäme. Deshalb steht neben jeder Grösse,
 * wie viele Bilder sie zulässt, und die Zahl stimmt.
 */

const STREIFEN = 8;
const STREIFEN_KANTE = 96;

/** Die Rechengrössen zur Wahl – längere Kante. */
const KANTEN = [
  { kante: 640, titel: '640', beschreibung: 'Klein und schnell. Reicht für den Chat.' },
  { kante: 960, titel: '960', beschreibung: 'Der Kompromiss.' },
  { kante: 1280, titel: '1280', beschreibung: 'Scharf – und deutlich langsamer.' },
] as const;

interface Lauf {
  readonly anteil: number;
  readonly abschnitt: Abschnitt;
  readonly text: string;
}

interface Wachposten {
  release(): Promise<void>;
}

export function VideoEditorSheet({
  video,
  name,
  onFertig,
  onClose,
  zielName = 'In den Chat',
}: {
  video: Blob;
  name?: string;
  onFertig?: (blob: Blob, dateiname: string) => Promise<void> | void;
  onClose: () => void;
  zielName?: string;
}) {
  const [dauerMs, setDauerMs] = useState(0);
  const [streifen, setStreifen] = useState<{ zeitMs: number; bild: string }[]>([]);
  const [quelle, setQuelle] = useState<{ b: number; h: number } | null>(null);
  /**
   * Die Stücke, aus denen der Film wird – in dieser Reihenfolge.
   *
   * Eine Liste und kein Von-Bis, weil „Schnittoptionen" genau das heisst: ein
   * Stück in der Mitte herausnehmen, zwei Ausschnitte hintereinanderhängen,
   * die Reihenfolge tauschen. Solange es EIN Stück gibt, sieht und bedient
   * sich das Blatt wie vorher – der zweite Satz Bedienelemente entsteht erst,
   * wenn jemand selbst ein zweites Stück angelegt hat.
   */
  const [stuecke, setStuecke] = useState<Stueck[]>([{ vonMs: 0, bisMs: 0 }]);
  /** Welches Stück die Griffe im Streifen bedienen. */
  const [aktiv, setAktiv] = useState(0);
  const [bildrate, setBildrate] = useState<number>(FILM_BILDRATE_VORGABE);
  const [kante, setKante] = useState<number>(960);
  const [doc, setDoc] = useState<BildDoc | null>(null);
  const [standbild, setStandbild] = useState<Blob | null>(null);
  const [editorAuf, setEditorAuf] = useState(false);
  const [holt, setHolt] = useState(false);
  const [absage, setAbsage] = useState<string | null>(null);
  const [lauf, setLauf] = useState<Lauf | null>(null);
  const [ergebnis, setErgebnis] = useState<{ url: string; blob: Blob; text: string } | null>(null);
  const [nachAbbruch, setNachAbbruch] = useState<number | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const steuerung = useRef<AbortController | null>(null);
  const wache = useRef<Wachposten | null>(null);

  /* ---------- Kann dieser Browser überhaupt Videos schreiben? ---------- */

  useEffect(() => {
    let gilt = true;
    void videoTauglich().then((befund) => {
      if (gilt && !befund.moeglich) setAbsage(befund.grund ?? null);
    });
    return () => {
      gilt = false;
    };
  }, []);

  /* ---------- Filmstreifen ---------- */

  useEffect(() => {
    let gilt = true;
    const abbruch = new AbortController();
    void (async () => {
      try {
        const erst = await videoBilderLesen(video, {
          zeitpunkte: [0],
          kante: STREIFEN_KANTE,
          abbruch: abbruch.signal,
        });
        if (!gilt) return;
        setDauerMs(erst.dauerMs);
        setQuelle({ b: erst.quellBreite, h: erst.quellHoehe });
        setStuecke([{ vonMs: 0, bisMs: Math.min(erst.dauerMs, 5000) }]);

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
        setStreifen(
          alle.bilder.map((bild) => {
            stift?.putImageData(bild.daten, 0, 0);
            return { zeitMs: bild.zeitMs, bild: flaeche.toDataURL('image/webp', 0.7) };
          }),
        );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  /* ---------- Was daraus wird ---------- */

  const rechenmass = quelle ? masse(quelle.b, quelle.h, kante) : null;
  const teile = doc ? inhaltsTeile(doc) : [];
  /*
   * Dieselbe Weiche wie in `videoBauen`, und das ist kein Zufall, sondern
   * Pflicht.
   *
   * Dort entscheidet `teile.length > 0 || hatFormTeile(doc)`, ob alle Bilder
   * gesammelt werden müssen. Eine Oberfläche, die ihre Grenze nur an
   * `teile.length` festmacht, verspricht bei einem Verlauf oder einem
   * Pinselstrich sechshundert Bilder – und der Maskenweg hält sie dann doch
   * alle, bis das Telefon den Reiter wegwirft.
   */
  const brauchtAlle = doc ? teile.length > 0 || hatFormTeile(doc) : false;
  /*
   * Ohne Masken zählt nur die Wartezeit, mit Masken der Speicher.
   *
   * Solange noch nichts eingestellt ist (`doc` ist null), gilt die
   * Strom-Grenze – denn genau so liefe der Film dann auch. Sie springt
   * später nur, wenn jemand wirklich einen inhaltsabhängigen Bereich anlegt,
   * und dann steht der Grund daneben.
   */
  const maxBilder = brauchtAlle
    ? rechenmass
      ? maxBilderFuer(rechenmass.b, rechenmass.h)
      : 1
    : MAX_BILDER_FILM;
  const plan = useMemo(
    () => filmZeitpunkte(stuecke, bildrate, maxBilder),
    [stuecke, bildrate, maxBilder],
  );
  const anzahl = plan.zeitpunkte.length;
  const schrittMs = filmSchrittMs(bildrate);

  /*
   * Der Schlüsselbildabstand hängt an der Bildrate, nicht an einer festen
   * Zahl: Bei fünf Bildern je Sekunde liegen vier Bilder fast eine Sekunde
   * auseinander, und so weit trägt keine Bewegungsschätzung. Ein halber
   * Sekundenabstand ist die Regel, mindestens aber jedes vierte.
   */
  const schluesselAbstand = Math.max(1, Math.min(4, Math.round(bildrate / 2)));
  const dauerSchaetzung = filmDauerSchaetzenMs(anzahl, brauchtAlle, schluesselAbstand);
  /** Der Anfang des ERSTEN Stücks – dort wird eingestellt. */
  const anfangMs = stuecke[0]?.vonMs ?? 0;

  /* ---------- Das Standbild für den Editor ---------- */

  const editorOeffnen = useCallback(async () => {
    if (!quelle || holt) return;
    setHolt(true);
    try {
      const gelesen = await videoBilderLesen(video, {
        zeitpunkte: [anfangMs],
        kante,
      });
      const flaeche = document.createElement('canvas');
      flaeche.width = gelesen.breite;
      flaeche.height = gelesen.hoehe;
      flaeche.getContext('2d')?.putImageData(gelesen.bilder[0].daten, 0, 0);
      const blob = await new Promise<Blob | null>((fertig) =>
        flaeche.toBlob((ergebnisBlob) => fertig(ergebnisBlob), 'image/png'),
      );
      if (!blob) throw new Error('Das Standbild liess sich nicht anlegen');
      setStandbild(blob);
      setEditorAuf(true);
    } catch (ausfall) {
      if (!(ausfall instanceof AbbruchError)) {
        toast(errorMessage(ausfall, 'Das Standbild ging nicht'), 'error');
      }
    } finally {
      setHolt(false);
    }
  }, [anfangMs, holt, kante, quelle, video]);

  /* ---------- Rechnen ---------- */

  const wachePruefen = useCallback(async (an: boolean) => {
    type MitWache = Navigator & { wakeLock?: { request(art: 'screen'): Promise<Wachposten> } };
    const zugang = (navigator as MitWache).wakeLock;
    if (an) {
      if (!zugang) return;
      try {
        wache.current = await zugang.request('screen');
      } catch {
        // Ein abgelehntes Recht ist kein Grund, nicht zu rechnen.
        wache.current = null;
      }
      return;
    }
    try {
      await wache.current?.release();
    } catch {
      /* schon weg */
    }
    wache.current = null;
  }, []);

  const starten = useCallback(
    async (nurBilder?: number) => {
      if (!doc || lauf) return;
      setNachAbbruch(null);
      const steuer = new AbortController();
      steuerung.current = steuer;
      setLauf({ anteil: 0, abschnitt: 'lesen', text: 'Bilder holen …' });
      await wachePruefen(true);
      try {
        const fertig = await videoAusVideo({
          datei: video,
          doc,
          stuecke,
          bildrate,
          kante,
          schluesselAbstand,
          /*
           * Nach einem Abbruch wird die GRENZE gesenkt, nicht das Ende
           * verschoben.
           *
           * Das Ende auszurechnen ginge bei einem Stück noch; bei dreien
           * läge es im falschen. Eine kleinere Obergrenze schneidet dagegen
           * genau dort ab, wo der Abbruch kam – quer über alle Stücke, in
           * derselben Reihenfolge.
           */
          maxBilder: nurBilder === undefined ? maxBilder : Math.min(maxBilder, nurBilder),
          fortschritt: (anteil, abschnitt, text) => setLauf({ anteil, abschnitt, text }),
          abbruch: steuer.signal,
        });
        setErgebnis({
          url: URL.createObjectURL(fertig.blob),
          blob: fertig.blob,
          text: `${fertig.bilder} Bilder · ${fertig.breite} × ${fertig.hoehe} · ${(
            fertig.blob.size / 1_000_000
          )
            .toFixed(1)
            .replace('.', ',')} MB`,
        });
      } catch (ausfall) {
        if (ausfall instanceof VideoBauAbbruch) {
          setNachAbbruch(ausfall.fertigeBilder >= 2 ? ausfall.fertigeBilder : null);
        } else if (!(ausfall instanceof AbbruchError)) {
          toast(errorMessage(ausfall, 'Das Video ging nicht'), 'error');
        }
      } finally {
        await wachePruefen(false);
        steuerung.current = null;
        setLauf(null);
      }
    },
    [bildrate, doc, kante, lauf, maxBilder, schluesselAbstand, stuecke, video, wachePruefen],
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

  const dateiname = `${(name ?? 'video').replace(/\.[^.]+$/, '')}-bearbeitet.webm`;

  /*
   * Der Fotoeditor liegt ÜBER dem Blatt, nicht anstelle davon.
   *
   * `beiseite` blendet das Blatt aus und lässt es stehen (`.is-beiseite` in
   * `global.css`) – dieselbe Lösung wie beim Blatt „Foto oder Video". Der
   * Grund sind die Ebenen: Der Editor liegt auf 75, ein Blatt auf 77. Wäre
   * das Blatt noch sichtbar, läge es über dem Editor, und jeder Fingertipp
   * ginge an das falsche von beiden.
   *
   * Das Blatt zu VERWERFEN wäre die andere Möglichkeit und die schlechtere:
   * Die Rollposition und jedes offene Aufklappfeld wären nach dem Zurückkommen
   * weg.
   */
  const editor =
    editorAuf && standbild ? (
      <BildEditor
        quelle={standbild}
        name={name ?? null}
        startDoc={doc}
        onClose={() => setEditorAuf(false)}
        dokumentName="Auf den Film anwenden"
        onDokument={(fertig) => setDoc(fertig)}
      />
    ) : null;

  /* ---------- Das Ergebnis ---------- */

  if (ergebnis) {
    return (
      <Sheet open onClose={onClose} title="Fertig">
        <div className="vg-ergebnis">
          <video className="vg-vorschau" src={ergebnis.url} controls playsInline loop muted />
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
          <a className="btn btn-ghost" href={ergebnis.url} download={dateiname}>
            Auf das Gerät speichern
          </a>
        </div>
      </Sheet>
    );
  }

  const nichtsGetan = !doc || (rechenmass && docUnberuehrt(doc, rechenmass.b, rechenmass.h));

  return (
    <>
      {editor}
      <Sheet open onClose={onClose} title="Video bearbeiten" beiseite={editorAuf}>
        <div className="stack">
          {absage && <p className="vg-absage">{absage}</p>}

          {streifen.length === 0 ? (
            <p className="vg-hinweis">
              <span className="spinner" aria-hidden="true" /> Das Video wird durchgesehen …
            </p>
          ) : (
            <>
              <Streifen
                bilder={streifen}
                dauerMs={dauerMs}
                stuecke={stuecke}
                aktiv={aktiv}
                gesperrt={lauf !== null}
                schrittMs={schrittMs}
                onAktiv={setAktiv}
                onBereich={(von, bis) =>
                  setStuecke((alt) =>
                    alt.map((eintrag, i) => (i === aktiv ? { vonMs: von, bisMs: bis } : eintrag)),
                  )
                }
              />
              <p className="vg-hinweis">
                {stuecke.length > 1 && `Stück ${aktiv + 1}: `}
                {zeitText(stuecke[aktiv]?.vonMs ?? 0)} – {zeitText(stuecke[aktiv]?.bisMs ?? 0)} ·{' '}
                {anzahl} {anzahl === 1 ? 'Bild' : 'Bilder'}
                {rechenmass && ` · ${rechenmass.b} × ${rechenmass.h}`} ·{' '}
                {sekundenText((anzahl * schrittMs) / 1000)} s Film · {dauerText(dauerSchaetzung)}
                {plan.gekuerztMs > 0 && (
                  <>
                    {' '}
                    <strong>
                      Hinten fallen {(plan.gekuerztMs / 1000).toFixed(1).replace('.', ',')} s weg –{' '}
                      {brauchtAlle
                        ? `bei dieser Grösse passen höchstens ${maxBilder} Bilder in den Speicher, weil die Bereiche am Bildinhalt hängen.`
                        : `mehr als ${maxBilder} Bilder dauern länger, als vor einem Balken zu sitzen erträglich ist. Bei ${halbeRate(bildrate)} Bildern je Sekunde wäre es doppelt so viel Film.`}
                    </strong>
                  </>
                )}
              </p>

              {/*
                  Die Schnittoptionen entstehen ERST, wenn jemand ein zweites
                  Stück angelegt hat.

                  Ein Film aus einem Stück ist der Normalfall, und für den
                  sieht das Blatt aus wie vorher: ein Streifen, zwei Griffe.
                  Wer die Liste nie braucht, bekommt sie auch nie zu sehen.
              */}
              <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={lauf !== null || dauerMs <= 0}
                  onClick={() => {
                    /*
                     * Das neue Stück fängt dort an, wo das aktive aufhört.
                     *
                     * Nicht bei null: Wer ein zweites Stück anlegt, will fast
                     * immer die Stelle DANACH – und ein Stück, das auf dem
                     * vorigen liegt, sähe aus wie ein Fehler.
                     */
                    const letzte = stuecke[aktiv] ?? { vonMs: 0, bisMs: 0 };
                    const von = Math.min(letzte.bisMs, Math.max(0, dauerMs - 1000));
                    setStuecke((alt) => [
                      ...alt,
                      { vonMs: von, bisMs: Math.min(dauerMs, von + 2000) },
                    ]);
                    setAktiv(stuecke.length);
                  }}
                >
                  ✂ Stück hinzufügen
                </button>
                {stuecke.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={lauf !== null}
                    onClick={() => {
                      setStuecke((alt) => alt.filter((_, i) => i !== aktiv));
                      setAktiv((alt) => Math.max(0, alt - 1));
                    }}
                  >
                    ␥ Stück {aktiv + 1} entfernen
                  </button>
                )}
                {stuecke.length > 1 &&
                  (['vor', 'zurueck'] as const).map((richtung) => (
                    <button
                      key={richtung}
                      type="button"
                      className="btn btn-sm"
                      disabled={
                        lauf !== null ||
                        (richtung === 'vor' ? aktiv === 0 : aktiv === stuecke.length - 1)
                      }
                      aria-label={
                        richtung === 'vor'
                          ? `Stück ${aktiv + 1} nach vorn`
                          : `Stück ${aktiv + 1} nach hinten`
                      }
                      onClick={() => {
                        const ziel = richtung === 'vor' ? aktiv - 1 : aktiv + 1;
                        setStuecke((alt) => {
                          const neu = alt.slice();
                          [neu[aktiv], neu[ziel]] = [neu[ziel], neu[aktiv]];
                          return neu;
                        });
                        setAktiv(ziel);
                      }}
                    >
                      {richtung === 'vor' ? '↑ nach vorn' : '↓ nach hinten'}
                    </button>
                  ))}
              </div>

              {stuecke.length > 1 && (
                <p className="vg-hinweis">
                  Der Film läuft in dieser Reihenfolge:{' '}
                  {stuecke
                    .map((eintrag) => `${zeitText(eintrag.vonMs)}–${zeitText(eintrag.bisMs)}`)
                    .join(' · ')}
                </p>
              )}
            </>
          )}

          {/*
          Die Grösse steht FEST, sobald etwas eingestellt ist – und das ist
          keine Bequemlichkeit.

          Ein `BildDoc` steht in Punkten seines Quellbildes. Eingestellt wird
          an einem Standbild in der Rechengrösse; ein Zuschnitt „von 0 bis
          160" meint bei 640 die linke Hälfte und bei 1280 das linke Viertel.
          Wer die Grösse danach wechselt, bekäme einen Ausschnitt, den er nie
          gewählt hat – ohne Fehlermeldung und ohne dass irgendwo stünde,
          woran es liegt.
        */}
          <fieldset className="vg-gruppe" disabled={lauf !== null || doc !== null}>
            <legend>Grösse</legend>
            <div className="vg-kacheln">
              {KANTEN.map((wahl) => (
                <button
                  key={wahl.kante}
                  type="button"
                  className={`vg-kachel${wahl.kante === kante ? ' ist-aktiv' : ''}`}
                  onClick={() => setKante(wahl.kante)}
                  title={wahl.beschreibung}
                >
                  {wahl.titel}
                </button>
              ))}
            </div>
            {doc && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={lauf !== null}
                onClick={() => {
                  setDoc(null);
                  setStandbild(null);
                }}
              >
                Grösse ändern – verwirft die Bearbeitung
              </button>
            )}
          </fieldset>

          <fieldset className="vg-gruppe" disabled={lauf !== null}>
            <legend>Bilder je Sekunde</legend>
            <div className="vg-kacheln">
              {FILM_BILDRATEN.map((rate) => (
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

          <button
            type="button"
            className="btn"
            onClick={() => void editorOeffnen()}
            disabled={streifen.length === 0 || holt || lauf !== null}
          >
            {holt ? '…' : doc ? '✏️ Bearbeitung ändern' : '✏️ Bearbeiten'}
          </button>

          {doc && (
            <p className="vg-hinweis">
              {nichtsGetan
                ? 'Noch nichts eingestellt – der Film käme so heraus, wie er hineingeht.'
                : teile.length === 0
                  ? 'Die Bearbeitung gilt für jedes Bild gleich. Das geht schnell.'
                  : `${teile.length === 1 ? 'Ein Bereich hängt' : `${teile.length} Bereiche hängen`} am Bildinhalt – Netz, Tiefe oder Antippen. Die werden auf jedem ${schluesselAbstand === 1 ? 'Bild' : `${schluesselAbstand}. Bild`} neu gerechnet und dazwischen mitgeschoben. Das dauert.`}
            </p>
          )}

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
                Abgebrochen – {nachAbbruch} Bilder waren schon fertig. Daraus trotzdem einen Film
                machen?
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
              disabled={!doc || absage !== null || anzahl === 0}
              onClick={() => void starten()}
            >
              Film bauen
            </button>
          )}
          {!doc && !absage && (
            <p className="vg-hinweis">
              Tipp zuerst auf „Bearbeiten“. Was du dort am ersten Bild einstellst, gilt danach für
              den ganzen Ausschnitt – auch Freistellen und Tiefenschärfe.
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}

/** „0:02,45" – eine Zeit, die man ablesen und vergleichen kann. */
function zeitText(ms: number): string {
  const gesamt = Math.max(0, ms);
  const minuten = Math.floor(gesamt / 60_000);
  const sekunden = Math.floor((gesamt % 60_000) / 1000);
  const hundertstel = Math.floor((gesamt % 1000) / 10);
  return `${minuten}:${String(sekunden).padStart(2, '0')},${String(hundertstel).padStart(2, '0')}`;
}

/** Sekunden mit einer Nachkommastelle, deutsch – und nie „0". */
function sekundenText(sekunden: number): string {
  if (sekunden < 0.05) return '<0,1';
  return sekunden.toFixed(1).replace('.', ',');
}

/**
 * Die nächstkleinere angebotene Rate.
 *
 * Für den Satz, der den Handel sichtbar macht, um den es bei der Grenze
 * geht: Flüssigkeit gegen Länge. Eine Zahl allein („höchstens 600 Bilder")
 * rechnet niemand in Sekunden um.
 */
function halbeRate(bildrate: number): number {
  const kleiner = FILM_BILDRATEN.filter((eintrag) => eintrag.rate < bildrate);
  return kleiner.length > 0 ? kleiner[kleiner.length - 1].rate : bildrate;
}
