import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Sheet } from '../../components/Sheet.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from '../media/helpers.js';
import { AbbruchError } from '../stickers/engines/index.js';
import {
  FILM_BILDRATEN,
  FILM_BILDRATE_VORGABE,
  filmSchrittMs,
  filmZeitpunkte,
} from './ausschnitt.js';
import { masse, videoBilderLesen } from './bilderLesen.js';
import { hatFormTeile, inhaltsTeile } from './bildweise.js';
import {
  MAX_BILDER_FILM,
  dauerText,
  filmDauerSchaetzenMs,
  maxBilderFuer,
} from './einstellungen.js';
import { useFilmWiedergabe } from './filmWiedergabe.js';
import { SchnittEditor } from './SchnittEditor.js';
import { filmZuQuelle } from './schnitt.js';
import { nochOffen, useSchnitt } from './schnittZustand.js';
import { videoTauglich } from './schreiben.js';
import {
  BAUSCHRITT_TITEL,
  VideoBauAbbruch,
  pufferGruppen,
  videoAusVideo,
  type Bauschritt,
} from './videoBauen.js';
import { Zeitleiste } from './Zeitleiste.js';

/**
 * Videobearbeitung – derselbe Editor wie beim Foto, Abschnitt für Abschnitt.
 *
 * # Warum an EINEM Bild je Abschnitt eingestellt wird
 *
 * Weil eine Bearbeitung eine Entscheidung ist. „Etwas wärmer, den Himmel
 * dunkler" gilt für eine ganze Einstellung; an fünfzig Bildern einzeln
 * eingestellt wären es fünfzig Mal dieselbe Entscheidung mit fünfzig leicht
 * verschiedenen Ergebnissen – und ein flackernder Film.
 *
 * Aber eben für eine EINSTELLUNG, nicht zwingend für den ganzen Film. Die
 * Zeitleiste teilt den Film in Abschnitte, und jeder trägt seine eigene
 * Bearbeitung – geschnitten und bearbeitet wird am selben Ort, im Editor mit
 * der Zeitleiste darunter (`SchnittEditor.tsx`).
 *
 * # Warum die Rechengrösse gewählt wird
 *
 * Weil alle Bilder unkomprimiert im Speicher liegen. Hundertfünfzig Bilder
 * bei 1280 × 720 sind 553 MB – dafür wirft ein Telefon den Reiter weg, ohne
 * dass irgendwo eine Fehlermeldung ankäme. Deshalb steht neben jeder Grösse,
 * wie viele Bilder sie zulässt, und die Zahl stimmt.
 */

/*
 * Sechzehn Vorschaubilder statt acht: Die Zeitleiste zeigt sie JE ABSCHNITT,
 * und ein kurzer Abschnitt aus einem langen Video bekam bei acht oft keines.
 */
const VORSCHAU = 16;
const VORSCHAU_KANTE = 96;

/** Die Rechengrössen zur Wahl – längere Kante. */
const KANTEN = [
  { kante: 640, titel: '640', beschreibung: 'Klein und schnell. Reicht für den Chat.' },
  { kante: 960, titel: '960', beschreibung: 'Der Kompromiss.' },
  { kante: 1280, titel: '1280', beschreibung: 'Scharf – und deutlich langsamer.' },
] as const;

interface Lauf {
  readonly anteil: number;
  readonly abschnitt: Bauschritt;
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
  const [vorschau, setVorschau] = useState<{ zeitMs: number; bild: string }[]>([]);
  const [quelle, setQuelle] = useState<{ b: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [quelleUrl, setQuelleUrl] = useState<string | null>(null);
  const [bildrate, setBildrate] = useState<number>(FILM_BILDRATE_VORGABE);
  const [kante, setKante] = useState<number>(960);
  const [editorAuf, setEditorAuf] = useState(false);
  const [absage, setAbsage] = useState<string | null>(null);
  const [lauf, setLauf] = useState<Lauf | null>(null);
  const [ergebnis, setErgebnis] = useState<{ url: string; blob: Blob; text: string } | null>(null);
  const [nachAbbruch, setNachAbbruch] = useState<number | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const steuerung = useRef<AbortController | null>(null);
  const wache = useRef<Wachposten | null>(null);

  const rechenmass = useMemo(
    () => (quelle ? masse(quelle.b, quelle.h, kante) : null),
    [quelle, kante],
  );
  const schrittMs = filmSchrittMs(bildrate);
  /**
   * Die Abschnitte des Films – jeder mit seiner eigenen Bearbeitung.
   *
   * Eine Liste und kein Von-Bis, weil „Schnittoptionen" genau das heisst: ein
   * Stück in der Mitte herausnehmen, zwei Ausschnitte hintereinanderhängen,
   * die Reihenfolge tauschen. Solange es EINEN Abschnitt gibt, gilt seine
   * Bearbeitung für den ganzen Film, wie bisher.
   */
  const schnitt = useSchnitt({
    datei: video,
    kante,
    schrittMs,
    quelleMs: dauerMs,
    mass: rechenmass,
  });
  const { abschnitte } = schnitt;
  const wiedergabe = useFilmWiedergabe(videoRef, abschnitte);

  /*
   * Zurück aus dem Editor steht das Video des Blatts neu da – auf seinem
   * ersten Bild, denn solange der Editor offen war, gab es es nicht. Die
   * Wiedergabestelle des Blatts gilt aber weiter; also springt es dorthin.
   */
  const stelle = useRef(0);
  stelle.current = wiedergabe.spielkopfMs;
  const { setzen: stelleSetzen } = wiedergabe;
  const warImEditor = useRef(false);
  useEffect(() => {
    if (warImEditor.current && !editorAuf) stelleSetzen(stelle.current);
    warImEditor.current = editorAuf;
  }, [editorAuf, stelleSetzen]);

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

  /*
   * Die Adresse für die LIVE-Vorschau – einmal je Datei, nicht bei jedem
   * Render. Sie muss wieder freigegeben werden, sonst hält der Browser die
   * Datei ein zweites Mal im Speicher, bis die Seite neu lädt.
   */
  useEffect(() => {
    const url = URL.createObjectURL(video);
    setQuelleUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);

  /* ---------- Vorschaubilder ---------- */

  const { anfangen } = schnitt;
  useEffect(() => {
    let gilt = true;
    const abbruch = new AbortController();
    void (async () => {
      try {
        const erst = await videoBilderLesen(video, {
          zeitpunkte: [0],
          kante: VORSCHAU_KANTE,
          abbruch: abbruch.signal,
        });
        if (!gilt) return;
        setDauerMs(erst.dauerMs);
        setQuelle({ b: erst.quellBreite, h: erst.quellHoehe });
        anfangen(Math.min(erst.dauerMs, 5000));

        const marken = Array.from({ length: VORSCHAU }, (_, i) =>
          Math.round((erst.dauerMs * i) / VORSCHAU),
        );
        const alle = await videoBilderLesen(video, {
          zeitpunkte: marken,
          kante: VORSCHAU_KANTE,
          abbruch: abbruch.signal,
        });
        if (!gilt) return;
        const flaeche = document.createElement('canvas');
        flaeche.width = alle.breite;
        flaeche.height = alle.hoehe;
        const stift = flaeche.getContext('2d');
        setVorschau(
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

  /*
   * Je Dokument EINMAL gezählt: Nach einem Teilen tragen beide Hälften
   * dasselbe, und ein Bereich stünde sonst zweimal da.
   */
  const teile = [...new Set(abschnitte.map((abschnitt) => abschnitt.doc))].reduce(
    (summe, doc) => summe + (doc ? inhaltsTeile(doc).length : 0),
    0,
  );
  const formen = abschnitte.some((abschnitt) => abschnitt.doc && hatFormTeile(abschnitt.doc));
  const bearbeitet = abschnitte.some((abschnitt) => abschnitt.doc !== null);
  /*
   * Zwei Grenzen: eine für den ganzen Film (die Wartezeit) und eine für jede
   * Gruppe, deren Bilder zum Verfolgen gesammelt werden (der Speicher).
   *
   * Dieselbe Weiche wie in `videoBauen` – `pufferGruppen` ist dieselbe
   * Funktion –, und das ist kein Zufall, sondern Pflicht: Eine Oberfläche,
   * die eine andere Grenze verspricht als die, die beim Bauen gilt, zeigt
   * einen Film an, der dann nicht herauskommt.
   */
  const mitForm = teile > 0 || formen;
  const maxBilder = MAX_BILDER_FILM;
  const maxGepuffert = rechenmass ? maxBilderFuer(rechenmass.b, rechenmass.h) : 1;
  const plan = useMemo(
    () =>
      filmZeitpunkte(abschnitte, bildrate, maxBilder, {
        gruppeJeStueck: pufferGruppen(abschnitte),
        max: maxGepuffert,
      }),
    [abschnitte, bildrate, maxBilder, maxGepuffert],
  );
  const anzahl = plan.zeitpunkte.length;
  /** Die Bilder, die durch ein Modell gehen – nur die zählen für die Masken. */
  const unterMaske = plan.stueckJeBild.filter((stueck) => {
    const doc = abschnitte[stueck]?.doc;
    return doc ? inhaltsTeile(doc).length > 0 : false;
  });
  const maskenBilder = unterMaske.length;
  const maskenAbschnitte = new Set(unterMaske).size;

  /*
   * Der Schlüsselbildabstand hängt an der Bildrate, nicht an einer festen
   * Zahl: Bei fünf Bildern je Sekunde liegen vier Bilder fast eine Sekunde
   * auseinander, und so weit trägt keine Bewegungsschätzung. Ein halber
   * Sekundenabstand ist die Regel, mindestens aber jedes vierte.
   */
  const schluesselAbstand = Math.max(1, Math.min(4, Math.round(bildrate / 2)));
  /*
   * Lesen und Schreiben kostet jedes Bild, die Modelle nur die Bilder unter
   * einer Maske. Jeder Abschnitt mit Maske setzt an beiden Enden neu an –
   * das zählt wie eine Schnittkante.
   */
  const dauerSchaetzung =
    filmDauerSchaetzenMs(anzahl - maskenBilder, false, schluesselAbstand) +
    filmDauerSchaetzenMs(maskenBilder, true, schluesselAbstand, maskenAbschnitte);
  /** Masken, die noch an ein neues Stellbild mitgenommen werden – bis dahin wird nicht gebaut. */
  const offen = nochOffen(abschnitte);

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

  /*
   * Das Angebot nach einem Abbruch gilt für DIESEN Schnitt. Wer danach
   * schneidet, hat einen anderen Film, und die Zahl stimmt nicht mehr.
   */
  useEffect(() => {
    setNachAbbruch(null);
  }, [abschnitte]);

  const starten = useCallback(
    async (nurBilder?: number) => {
      if (lauf || abschnitte.length === 0 || nochOffen(abschnitte)) return;
      wiedergabe.anhalten();
      setNachAbbruch(null);
      const steuer = new AbortController();
      steuerung.current = steuer;
      setLauf({ anteil: 0, abschnitt: 'lesen', text: 'Bilder holen …' });
      await wachePruefen(true);
      try {
        const fertig = await videoAusVideo({
          datei: video,
          stuecke: abschnitte,
          bildrate,
          kante,
          schluesselAbstand,
          /*
           * Nach einem Abbruch wird die GRENZE gesenkt, nicht das Ende
           * verschoben.
           *
           * Das Ende auszurechnen ginge bei einem Abschnitt noch; bei dreien
           * läge es im falschen. Eine kleinere Obergrenze schneidet dagegen
           * genau dort ab, wo der Abbruch kam – quer über alle Abschnitte,
           * in derselben Reihenfolge.
           */
          maxBilder: nurBilder === undefined ? maxBilder : Math.min(maxBilder, nurBilder),
          maxGepuffert,
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
          /*
           * Das Angebot nur, wenn wirklich etwas zu KÜRZEN ist.
           *
           * Wären alle Bilder fertig, startete „Ja, aus N Bildern" denselben
           * Auftrag noch einmal von null – samt aller Modelläufe.
           */
          const fertig = ausfall.fertigeBilder;
          setNachAbbruch(fertig >= 2 && fertig < anzahl ? fertig : null);
        } else if (!(ausfall instanceof AbbruchError)) {
          toast(errorMessage(ausfall, 'Das Video ging nicht'), 'error');
        }
      } finally {
        await wachePruefen(false);
        steuerung.current = null;
        setLauf(null);
      }
    },
    [
      abschnitte,
      anzahl,
      bildrate,
      kante,
      lauf,
      maxBilder,
      maxGepuffert,
      schluesselAbstand,
      video,
      wachePruefen,
      wiedergabe,
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

  const dateiname = `${(name ?? 'video').replace(/\.[^.]+$/, '')}-bearbeitet.webm`;

  /*
   * Der Editor liegt ÜBER dem Blatt, nicht anstelle davon.
   *
   * `beiseite` blendet das Blatt aus und lässt es stehen (`.is-beiseite` in
   * `global.css`) – dieselbe Lösung wie beim Blatt „Foto oder Video". Der
   * Grund sind die Ebenen: Der Editor liegt auf 75, ein Blatt auf 77. Wäre
   * das Blatt noch sichtbar, läge es über dem Editor, und jeder Fingertipp
   * ginge an das falsche von beiden.
   */
  const editor =
    editorAuf && quelleUrl ? (
      <SchnittEditor
        schnitt={schnitt}
        datei={video}
        quelleUrl={quelleUrl}
        kante={kante}
        schrittMs={schrittMs}
        quelleMs={dauerMs}
        vorschau={vorschau}
        name={name ?? null}
        onClose={() => setEditorAuf(false)}
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

  return (
    <>
      {editor}
      <Sheet open onClose={onClose} title="Video bearbeiten" beiseite={editorAuf}>
        <div className="stack">
          {absage && <p className="vg-absage">{absage}</p>}

          {vorschau.length === 0 || abschnitte.length === 0 ? (
            <p className="vg-hinweis">
              <span className="spinner" aria-hidden="true" /> Das Video wird durchgesehen …
            </p>
          ) : (
            <>
              {/*
                  Nur, solange das Blatt zu sehen ist: Der Editor hat sein
                  eigenes Video, und jedes weitere hielte auf einem Telefon
                  einen Dekodierer samt Puffer fest, der gegen die Wiedergabe
                  dort und gegen die Mitnahme der Masken arbeitet.
              */}
              {!editorAuf && (
                <video
                  ref={videoRef}
                  className="vg-quelle"
                  src={quelleUrl ?? undefined}
                  playsInline
                  muted
                  preload="metadata"
                />
              )}
              <Zeitleiste
                abschnitte={abschnitte}
                aktiv={schnitt.aktiv}
                spielkopfMs={wiedergabe.spielkopfMs}
                quelleMs={dauerMs}
                schrittMs={schrittMs}
                vorschau={vorschau}
                spielt={wiedergabe.spielt}
                gesperrt={lauf !== null}
                beschaeftigt={schnitt.beschaeftigt}
                onSpielkopf={(filmMs, fertig) => {
                  wiedergabe.setzen(filmMs);
                  if (!fertig) return;
                  const ort = filmZuQuelle(abschnitte, filmMs);
                  if (ort) schnitt.setAktiv(ort.nummer);
                }}
                onKuerzen={(nummer, vonMs, bisMs, fertig) => {
                  // Erst anhalten – eine laufende Wiedergabe hielte die
                  // gezogene Kante für das Ende und spränge weiter.
                  if (wiedergabe.spielt) wiedergabe.anhalten();
                  if (!fertig) {
                    // Beim Ziehen zeigt das Video die Kante, an der man ist.
                    const element = videoRef.current;
                    const alt = abschnitte[nummer];
                    if (element && alt) {
                      element.currentTime = (vonMs !== alt.vonMs ? vonMs : bisMs) / 1000;
                    }
                    return;
                  }
                  schnitt.kuerzen(nummer, vonMs, bisMs);
                }}
                onAbspielen={() =>
                  wiedergabe.spielt ? wiedergabe.anhalten() : wiedergabe.abspielen()
                }
                onTeilen={() => {
                  wiedergabe.anhalten();
                  const ort = filmZuQuelle(abschnitte, wiedergabe.spielkopfMs);
                  if (ort) schnitt.teilen(ort.nummer, ort.quelleMs);
                }}
                onEntfernen={() => {
                  wiedergabe.anhalten();
                  schnitt.entfernen();
                }}
                onVerschieben={(richtung) => {
                  wiedergabe.anhalten();
                  schnitt.verschieben(richtung);
                }}
                onDazu={() => {
                  wiedergabe.anhalten();
                  schnitt.dazu();
                }}
              />
              <p className="vg-hinweis">
                {abschnitte.length > 1 && `${abschnitte.length} Abschnitte · `}
                {anzahl} {anzahl === 1 ? 'Bild' : 'Bilder'}
                {rechenmass && ` · ${rechenmass.b} × ${rechenmass.h}`} ·{' '}
                {sekundenText((anzahl * schrittMs) / 1000)} s Film · {dauerText(dauerSchaetzung)}
                {plan.gekuerztMs > 0 && (
                  <>
                    {' '}
                    <strong>
                      Hinten fallen {(plan.gekuerztMs / 1000).toFixed(1).replace('.', ',')} s weg –{' '}
                      {plan.gekuerztWegen === 'puffer'
                        ? `ein Abschnitt mit Maske oder Form darf bei dieser Grösse höchstens ${maxGepuffert} Bilder lang sein – zum Verfolgen liegen seine Bilder alle gleichzeitig im Speicher. Kürzer schneiden oder teilen hilft.`
                        : `mehr als ${maxBilder} Bilder dauern länger, als vor einem Balken zu sitzen erträglich ist – das sind ${sekundenText(maxBilder / bildrate)} s Film.${
                            naechstKleiner(bildrate) < bildrate
                              ? ` Bei ${naechstKleiner(bildrate)} Bildern je Sekunde wären es ${sekundenText(maxBilder / naechstKleiner(bildrate))} s.`
                              : ''
                          }`}
                    </strong>
                  </>
                )}
              </p>
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
          <fieldset className="vg-gruppe" disabled={lauf !== null || bearbeitet}>
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
            {bearbeitet && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={lauf !== null}
                onClick={() => schnitt.alleVerwerfen()}
              >
                Grösse ändern – verwirft alle Bearbeitungen
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
            onClick={() => {
              wiedergabe.anhalten();
              setEditorAuf(true);
            }}
            disabled={vorschau.length === 0 || abschnitte.length === 0 || lauf !== null}
          >
            ✏️ Bearbeiten und schneiden
          </button>

          <p className="vg-hinweis">
            {/*
                Drei Lagen, und der Unterschied zwischen der zweiten und der
                dritten ist nicht offensichtlich.

                Bei INHALTSTEILEN (Netz, Tiefe, Antippen) läuft ein Modell, und
                das kostet Minuten. Dazwischen liegt der Fall, der lange falsch
                beschrieben war: ein Verlauf, eine Ellipse, ein Pinselstrich.
                Der hängt nicht am Bildinhalt und braucht kein Modell – aber er
                muss mit der Kamera mitwandern, und dafür wird die Bewegung
                über seinen Abschnitt geschätzt. Also liegen dessen Bilder
                gleichzeitig im Speicher, und genau daran hängt die kleinere
                Obergrenze je Abschnitt oben.
            */}
            {!bearbeitet
              ? 'Noch nichts eingestellt – der Film käme geschnitten, sonst aber so heraus, wie er hineingeht. Im Editor wird jeder Abschnitt für sich bearbeitet; teilen, kürzen und verschieben geht dort ebenso.'
              : teile > 0
                ? `${teile === 1 ? 'Ein Bereich hängt' : `${teile} Bereiche hängen`} am Bildinhalt – Netz, Tiefe oder Antippen. Die werden auf jedem ${schluesselAbstand === 1 ? 'Bild' : `${schluesselAbstand}. Bild`} neu gerechnet und folgen dazwischen dem Gegenstand. Das dauert.`
                : mitForm
                  ? 'Ein Bereich beschreibt eine Form – Verlauf, Ellipse oder Pinselstrich. Der wandert mit der Kamera mit, dafür wird die Bewegung über seinen Abschnitt geschätzt. Kein Modell, aber dessen Bilder liegen auf einmal im Speicher.'
                  : 'Die Bearbeitung gilt für jedes Bild eines Abschnitts gleich. Das geht schnell, und die Bilder werden einzeln durchgereicht statt gesammelt.'}
          </p>

          {offen && !lauf && (
            <p className="vg-hinweis">
              <span className="spinner" aria-hidden="true" /> Masken werden an ein neues Stellbild
              mitgenommen – danach lässt sich der Film bauen.
            </p>
          )}

          {lauf && (
            <div className="stk-lauf">
              <strong>{BAUSCHRITT_TITEL[lauf.abschnitt]}</strong>
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
                  disabled={offen}
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
              disabled={absage !== null || anzahl === 0 || abschnitte.length === 0 || offen}
              onClick={() => void starten()}
            >
              Film bauen
            </button>
          )}
        </div>
      </Sheet>
    </>
  );
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
function naechstKleiner(bildrate: number): number {
  const kleiner = FILM_BILDRATEN.filter((eintrag) => eintrag.rate < bildrate);
  return kleiner.length > 0 ? kleiner[kleiner.length - 1].rate : bildrate;
}
