import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useDialogAnmeldung } from '../../lib/dialogAnmeldung.js';
import { toast, useHideNav } from '../../state/ui.js';
import { BildEditor } from '../bild/BildEditor.js';
import type { BildDoc } from '../bild/doc.js';
import { errorMessage } from '../media/helpers.js';
import { AbbruchError } from '../stickers/engines/index.js';
import { videoLeserOeffnen, type VideoLeser } from './bilderLesen.js';
import { useFilmWiedergabe } from './filmWiedergabe.js';
import { filmZuQuelle, haengtAmBild, quelleZuFilm, standImRaster } from './schnitt.js';
import type { SchnittZustand } from './schnittZustand.js';
import { Zeitleiste, stellbildImFilm, zeitText } from './Zeitleiste.js';

/**
 * Der Fotoeditor mit einer Zeitleiste darunter – bearbeiten und schneiden
 * an einem Ort.
 *
 * # Was man sieht
 *
 * Oben das STELLBILD des gewählten Abschnitts, mit allem, was an ihm
 * eingestellt ist – genau wie beim Foto. Darunter die Zeitleiste. Wer darin
 * einen anderen Abschnitt antippt, bearbeitet diesen; wer die
 * Wiedergabestelle innerhalb eines Abschnitts verschiebt, bekommt dort sein
 * Stellbild. Beim Abspielen liegt das laufende Video über dem Standbild –
 * OHNE Bearbeitung, denn die gerechneten Masken gibt es erst im fertigen
 * Film, und eine Vorschau, in der die Maske stehen bliebe, sähe genau so
 * aus wie der Fehler, den sie nicht hat.
 *
 * # Die eine Ausnahme beim Verschieben
 *
 * Trägt ein Abschnitt eine Maske (Freistellen, Tiefe, Tipp) oder eine Form
 * (Verlauf, Ellipse, Pinsel), gehört sie zu EINEM Bild. Das Stellbild
 * einfach mitzuziehen hiesse, sie über ein anderes Bild zu legen. Dann
 * bleibt das Stellbild, wo es ist, und oben steht, was sich tun lässt: sie
 * an die neue Stelle mitnehmen (sie werden dorthin verfolgt) oder zurück
 * zum Stellbild.
 *
 * # Warum der Editor nicht je Abschnitt neu entsteht
 *
 * Weil die Zeitleiste in ihm steht. Neu aufgebaut verlor sie bei jedem
 * Abschnittswechsel ihren Fokus (Pfeiltasten über eine Grenze hinweg taten
 * danach nichts mehr) und jeden laufenden Zug. Stattdessen bekommt DERSELBE
 * Editor ein neues Bild und ein neues Dokument, und `sitzung` sagt ihm, dass
 * sein Rückgängig-Verlauf nicht mehr gilt.
 *
 * # Warum Wiedergabe und Zeitleiste nur eingehängt werden
 *
 * Weil sie sich bei jedem Bild der Wiedergabe ändern und der Editor nicht.
 * Als gewöhnliche Kinder gereicht, rechnete der ganze Editor – viertausend
 * Zeilen – bei jedem Bild der Anzeige mit: gemessen die Hälfte der Zeit
 * beim Abspielen, auf einem gedrosselten Gerät so viel, dass die Grenzen der
 * Abschnitte zu spät erkannt wurden und herausgeschnittene Bilder
 * aufblitzten. Jetzt bekommt der Editor zwei Steckplätze, die sich nie
 * ändern (`Steckplatz`), und was darin steht, zeichnet dieser Baum hier
 * selbst hinein. Der Editor rechnet nur noch, wenn sich an IHM etwas ändert.
 */
export function SchnittEditor({
  schnitt,
  datei,
  quelleUrl,
  kante,
  schrittMs,
  quelleMs,
  vorschau,
  name,
  onClose,
}: {
  schnitt: SchnittZustand;
  datei: Blob;
  quelleUrl: string;
  kante: number;
  schrittMs: number;
  quelleMs: number;
  vorschau: readonly { zeitMs: number; bild: string }[];
  name?: string | null;
  onClose: () => void;
}) {
  useHideNav(true);
  const { abschnitte, aktiv } = schnitt;
  const abschnitt = abschnitte[aktiv];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wiedergabe = useFilmWiedergabe(videoRef, abschnitte);
  const [zieht, setZieht] = useState(false);

  /* ---------- Das Standbild ---------- */

  /*
   * EIN Leser für die ganze Sitzung, und alle Sprünge darin nacheinander.
   *
   * Je Standbild ein neues Videoelement kostete jedes Mal das Laden der
   * Metadaten; zwei Sprünge im selben Element zugleich lieferten beide das
   * Bild, bei dem der spätere ankam. Der Rand ist die halbe Schrittweite,
   * wie beim Filmbau – sonst läge das Stellbild am Filmende auf einem
   * anderen Bild als das, das später gerechnet wird.
   */
  const leser = useRef<Promise<VideoLeser> | null>(null);
  const kette = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const offen = videoLeserOeffnen(datei, { kante, randMs: schrittMs / 2 });
    leser.current = offen;
    offen.catch(() => undefined);
    return () => {
      leser.current = null;
      void offen.then((l) => l.schliessen()).catch(() => undefined);
    };
  }, [datei, kante, schrittMs]);

  const zwischenspeicher = useRef(new Map<number, Blob>());
  const [standbild, setStandbild] = useState<{ id: string; ms: number; blob: Blob } | null>(null);

  const id = abschnitt?.id;
  const standMs = abschnitt?.standMs;
  useEffect(() => {
    if (id === undefined || standMs === undefined) return undefined;
    let gilt = true;
    const fertig = (blob: Blob) => {
      if (gilt) setStandbild({ id, ms: standMs, blob });
    };
    const gemerkt = zwischenspeicher.current.get(standMs);
    if (gemerkt) {
      fertig(gemerkt);
      return () => {
        gilt = false;
      };
    }
    const holen = async () => {
      const offen = leser.current;
      if (!offen || !gilt) return;
      const daten = await (await offen).bildAn(standMs);
      const blob = await alsPng(daten);
      const speicher = zwischenspeicher.current;
      speicher.set(standMs, blob);
      // Ein Dutzend genügt fürs Hin- und Herspringen; mehr hielte nur Speicher fest.
      if (speicher.size > 12) speicher.delete(speicher.keys().next().value as number);
      fertig(blob);
    };
    kette.current = kette.current.then(holen).catch((ausfall: unknown) => {
      if (gilt && !(ausfall instanceof AbbruchError)) {
        toast(errorMessage(ausfall, 'Das Standbild ging nicht'), 'error');
      }
    });
    return () => {
      gilt = false;
    };
  }, [id, standMs]);

  const beschaeftigt = abschnitt ? schnitt.beschaeftigt.has(abschnitt.id) : false;
  const stillBereit =
    standbild !== null &&
    abschnitt !== undefined &&
    standbild.id === abschnitt.id &&
    standbild.ms === abschnitt.standMs;

  /*
   * Was der Editor gerade zeigt: Bild, Dokument und Abschnitt – IMMER als
   * Paar.
   *
   * Übernommen wird ein neues Paar erst, wenn das Stellbild des gewählten
   * Abschnitts da ist und an ihm nichts mehr gerechnet wird. Bis dahin zeigt
   * der Editor das vorige, gesperrt und von der Wiedergabe verdeckt. Ein
   * Bild von hier mit dem Dokument von dort hätte eine Maske über das
   * falsche Bild gelegt – und der Editor meldet jede Änderung sofort
   * zurück, schon beim Laden.
   */
  const [gezeigt, setGezeigt] = useState<{
    id: string;
    ms: number;
    blob: Blob;
    doc: BildDoc | null;
  } | null>(null);
  useEffect(() => {
    if (!abschnitt || !stillBereit || beschaeftigt || !standbild) return;
    if (gezeigt && gezeigt.id === abschnitt.id && gezeigt.ms === abschnitt.standMs) return;
    setGezeigt({
      id: abschnitt.id,
      ms: abschnitt.standMs,
      blob: standbild.blob,
      doc: abschnitt.doc,
    });
  }, [abschnitt, beschaeftigt, gezeigt, standbild, stillBereit]);
  const bereit =
    gezeigt !== null &&
    abschnitt !== undefined &&
    gezeigt.id === abschnitt.id &&
    gezeigt.ms === abschnitt.standMs &&
    !beschaeftigt;
  const bereitRef = useRef(bereit);
  bereitRef.current = bereit;

  /* ---------- Wiedergabestelle ---------- */

  /** Beim Öffnen steht die Wiedergabe auf dem Stellbild. */
  const angefangen = useRef(false);
  useEffect(() => {
    if (angefangen.current || abschnitte.length === 0) return;
    angefangen.current = true;
    wiedergabe.setzen(stellbildImFilm(abschnitte, aktiv) ?? 0);
  }, [abschnitte, aktiv, wiedergabe]);

  /**
   * Die Wiedergabe ist an einer Stelle zur Ruhe gekommen – nach dem Ziehen
   * oder nach dem Anhalten. Hier entscheidet sich, welcher Abschnitt
   * gewählt ist und wo sein Stellbild liegt.
   */
  const ankommen = useCallback(
    (filmMs: number) => {
      const ort = filmZuQuelle(abschnitte, filmMs);
      if (!ort) return;
      if (ort.nummer !== aktiv) schnitt.setAktiv(ort.nummer);
      const ziel = abschnitte[ort.nummer];
      if (!ziel || schnitt.beschaeftigt.has(ziel.id)) return;
      const neu = standImRaster(ziel, ort.quelleMs, schrittMs);
      /*
       * Verglichen wird Rasterbild mit Rasterbild, nicht mit dem gespeicherten
       * Stellbild: Nach einem Teilen liegt das auf dem Raster des GANZEN
       * Abschnitts, die Hälfte hat ihr eigenes – und dasselbe Bild galte
       * sonst als ein anderes.
       */
      if (Math.abs(neu - standImRaster(ziel, ziel.standMs, schrittMs)) < 0.5) return;
      if (!haengtAmBild(ziel.doc)) schnitt.standSetzen(ziel.id, neu);
    },
    [abschnitte, aktiv, schnitt, schrittMs],
  );

  const spielteVorher = useRef(false);
  useEffect(() => {
    // Hält ein Fingertipp in die Leiste die Wiedergabe an, entscheidet erst
    // das Loslassen – nicht der Stand beim Aufsetzen.
    if (spielteVorher.current && !wiedergabe.spielt && !zieht) ankommen(wiedergabe.spielkopfMs);
    spielteVorher.current = wiedergabe.spielt;
  }, [ankommen, wiedergabe.spielkopfMs, wiedergabe.spielt, zieht]);

  const ort = filmZuQuelle(abschnitte, wiedergabe.spielkopfMs);
  const hierMs =
    abschnitt && ort && ort.nummer === aktiv
      ? standImRaster(abschnitt, ort.quelleMs, schrittMs)
      : null;
  /*
   * Nur wo etwas am Bild hängt, ist „anderswo stehen" eine Frage. Ohne
   * Masken und Formen wandert das Stellbild beim Loslassen mit; steht die
   * Wiedergabe nach einem Kürzen oder Verschieben woanders, ist das kein
   * Grund, das Bild zuzudecken.
   */
  const abweichend =
    !wiedergabe.spielt &&
    !zieht &&
    !beschaeftigt &&
    abschnitt !== undefined &&
    haengtAmBild(abschnitt.doc) &&
    hierMs !== null &&
    Math.abs(hierMs - standImRaster(abschnitt, abschnitt.standMs, schrittMs)) >= 0.5;
  const ueberlagert = wiedergabe.spielt || zieht || abweichend || beschaeftigt || !bereit;

  /* ---------- Die beiden Steckplätze ---------- */

  /*
   * Was über und unter der Bühne steht, lebt AUSSERHALB des Editors und wird
   * nur eingehängt – siehe oben.
   *
   * Das hat noch einen zweiten Grund: Beim ersten Öffnen steht der Editor
   * erst, wenn sein erstes Standbild da ist; bis dahin hängen Video und
   * Zeitleiste in einem schlichten Rahmen. Hingen sie im Editor selbst,
   * begänne das Video beim Wechsel von vorn zu laden, und ein Zug an der
   * Zeitleiste risse ab.
   */
  const ueberKnoten = useMemo(steckKnoten, []);
  const unterKnoten = useMemo(steckKnoten, []);
  const ueberBuehne = useMemo(() => <Steckplatz knoten={ueberKnoten} />, [ueberKnoten]);
  const unterBuehne = useMemo(() => <Steckplatz knoten={unterKnoten} />, [unterKnoten]);

  /* ---------- Das Video über der Bühne ---------- */

  const zeile = beschaeftigt ? (
    <div className="bild-wiedergabe-zeile">
      <span>
        <span className="spinner" aria-hidden="true" /> Masken und Formen werden an das Stellbild
        bei {zeitText(abschnitt?.standMs ?? 0)} mitgenommen …
      </span>
    </div>
  ) : abweichend && abschnitt && hierMs !== null ? (
    <div className="bild-wiedergabe-zeile">
      <span>
        Eingestellt wird bei {zeitText(abschnitt.standMs)} – Masken und Formen dieses Abschnitts
        gehören zu jenem Bild.
      </span>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => schnitt.standSetzen(abschnitt.id, hierMs)}
      >
        Masken hierher mitnehmen
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => wiedergabe.setzen(quelleZuFilm(abschnitte, aktiv, abschnitt.standMs))}
      >
        Zum Stellbild
      </button>
    </div>
  ) : wiedergabe.spielt ? (
    <div className="bild-wiedergabe-zeile">
      <span>Wiedergabe ohne Bearbeitung – die zeigt erst der fertige Film.</span>
    </div>
  ) : null;

  const wiedergabeFlaeche = (
    <div className="bild-wiedergabe" hidden={!ueberlagert}>
      <div className="bild-wiedergabe-platz">
        <video
          ref={videoRef}
          src={quelleUrl}
          playsInline
          muted
          preload="auto"
          className="bild-wiedergabe-video"
        />
      </div>
      {zeile}
    </div>
  );

  /** Eine Änderung an der Folge der Abschnitte hält die Wiedergabe an – sie liefe sonst gegen sie. */
  const umbauen = (tun: () => void) => {
    if (wiedergabe.spielt) wiedergabe.anhalten();
    tun();
  };

  const zeitleiste = (
    <Zeitleiste
      abschnitte={abschnitte}
      aktiv={aktiv}
      spielkopfMs={wiedergabe.spielkopfMs}
      quelleMs={quelleMs}
      schrittMs={schrittMs}
      vorschau={vorschau}
      spielt={wiedergabe.spielt}
      beschaeftigt={schnitt.beschaeftigt}
      stellbildMs={stellbildImFilm(abschnitte, aktiv)}
      onSpielkopf={(filmMs, fertig) => {
        wiedergabe.setzen(filmMs);
        setZieht(!fertig);
        if (fertig) ankommen(filmMs);
      }}
      onKuerzen={(nummer, vonMs, bisMs, fertig) => {
        /*
         * Erst anhalten, dann vorführen: Lief die Wiedergabe weiter, hielte
         * sie die Kante, an der gerade gezogen wird, für das Ende des
         * Abschnitts, spränge in den nächsten und bliebe danach im Zustand
         * „spielt" stehen – mit angehaltenem Video und zugedecktem Bild.
         */
        if (wiedergabe.spielt) wiedergabe.anhalten();
        const element = videoRef.current;
        if (!fertig) {
          // Beim Ziehen zeigt das Video die Kante, an der man gerade ist.
          setZieht(true);
          const alt = abschnitte[nummer];
          if (element && alt) element.currentTime = (vonMs !== alt.vonMs ? vonMs : bisMs) / 1000;
          return;
        }
        setZieht(false);
        schnitt.kuerzen(nummer, vonMs, bisMs);
      }}
      onAbspielen={() => (wiedergabe.spielt ? wiedergabe.anhalten() : wiedergabe.abspielen())}
      onTeilen={() =>
        umbauen(() => {
          const hier = filmZuQuelle(abschnitte, wiedergabe.spielkopfMs);
          if (hier) schnitt.teilen(hier.nummer, hier.quelleMs);
        })
      }
      onEntfernen={() => umbauen(schnitt.entfernen)}
      onVerschieben={(richtung) => umbauen(() => schnitt.verschieben(richtung))}
      onDazu={() => umbauen(schnitt.dazu)}
    />
  );

  const titel =
    abschnitte.length > 1 ? `Abschnitt ${aktiv + 1} von ${abschnitte.length}` : 'Video bearbeiten';

  useDialogAnmeldung(gezeigt === null, onClose);

  /*
   * Alles, was der Editor bekommt, bleibt dasselbe, solange sich an ihm
   * nichts ändert – sonst rechnete `RuhigerEditor` doch wieder bei jedem
   * Bild der Wiedergabe.
   */
  const { docSetzen } = schnitt;
  const aenderung = useCallback(
    (doc: BildDoc, herkunft: { quelle: Blob; sitzung?: string }) => {
      // Nur, solange Bild, Dokument und Abschnitt zusammenpassen – siehe
      // `gezeigt` –, und nur für ein Dokument, das zu diesem Bild geladen
      // wurde, nicht für das vorige, das beim Laden noch dasteht.
      if (!bereitRef.current || !gezeigt) return;
      if (herkunft.quelle !== gezeigt.blob || herkunft.sitzung !== gezeigt.id) return;
      docSetzen(gezeigt.id, doc);
    },
    [docSetzen, gezeigt],
  );
  const schliessenRef = useRef(onClose);
  schliessenRef.current = onClose;
  const schliessen = useCallback(() => schliessenRef.current(), []);

  return (
    <>
      {createPortal(wiedergabeFlaeche, ueberKnoten)}
      {createPortal(zeitleiste, unterKnoten)}
      {gezeigt ? (
        <RuhigerEditor
          quelle={gezeigt.blob}
          sitzung={gezeigt.id}
          startDoc={gezeigt.doc}
          name={name ?? null}
          ohneEntwurf
          titel={titel}
          gesperrt={!bereit}
          onAenderung={aenderung}
          onClose={schliessen}
          onDokument={nichts}
          dokumentName="Fertig"
          ueberBuehne={ueberBuehne}
          unterBuehne={unterBuehne}
        />
      ) : (
        createPortal(
          <div
            className="bild-editor mit-zeitleiste"
            role="dialog"
            aria-modal="true"
            aria-label={titel}
          >
            <header className="bild-kopf">
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
                ✕
              </button>
              <strong className="truncate">{titel}</strong>
            </header>
            <div className="bild-buehne">{ueberBuehne}</div>
            <div className="bild-zeitleiste">{unterBuehne}</div>
            <div className="bild-fuss">
              <p className="bild-hinweis">
                <span className="spinner" aria-hidden="true" /> Standbild wird geholt …
              </p>
            </div>
          </div>,
          document.body,
        )
      )}
    </>
  );
}

/** Der Fotoeditor, der nur neu rechnet, wenn sich seine Angaben ändern. */
const RuhigerEditor = memo(BildEditor);

const nichts = () => undefined;

/** Ein Knoten, der an wechselnden Stellen eingehängt wird – siehe `Steckplatz`. */
function steckKnoten(): HTMLDivElement {
  const knoten = document.createElement('div');
  knoten.className = 'bild-steckplatz';
  return knoten;
}

/**
 * Hängt einen Knoten, den ein anderer Teil des Baums füllt, an diese Stelle.
 *
 * Ändert sich nie, also rechnet auch der nicht neu, in dem er steht. Beide –
 * der Platz und der Knoten – tragen `display: contents`: Für das Layout
 * stehen die Kinder des Knotens direkt dort, wo der Platz ist.
 */
function Steckplatz({ knoten }: { knoten: HTMLElement }) {
  const einhaengen = useCallback(
    (platz: HTMLDivElement | null) => {
      if (platz && knoten.parentNode !== platz) platz.appendChild(knoten);
    },
    [knoten],
  );
  return <div ref={einhaengen} className="bild-steckplatz" />;
}

/** Ein Bild als PNG – der Editor lädt Dateien, keine Pixelfelder. */
async function alsPng(daten: ImageData): Promise<Blob> {
  const flaeche = document.createElement('canvas');
  flaeche.width = daten.width;
  flaeche.height = daten.height;
  flaeche.getContext('2d')?.putImageData(daten, 0, 0);
  const blob = await new Promise<Blob | null>((fertig) =>
    flaeche.toBlob((ergebnis) => fertig(ergebnis), 'image/png'),
  );
  if (!blob) throw new Error('Das Standbild liess sich nicht anlegen');
  return blob;
}
