import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useDialogAnmeldung } from '../../lib/dialogAnmeldung.js';
import { toast, useHideNav } from '../../state/ui.js';
import { BildEditor } from '../bild/BildEditor.js';
import type { BildDoc } from '../bild/doc.js';
import { errorMessage } from '../media/helpers.js';
import { AbbruchError } from '../stickers/engines/index.js';
import { masse } from './bilderLesen.js';
import { useVorschauDoc } from './filmDoc.js';
import { useFilmWiedergabe } from './filmWiedergabe.js';
import { restText, type MaskenLeiste } from './Maskenbahnen.js';
import { bereichePlatz, bildDocAn, type Gezeigt } from './masken.js';
import { bildIndex, bildMitte } from './raster.js';
import { MAX_BILDER_FILM } from './einstellungen.js';
import { filmZuQuelle, standImRaster } from './schnitt.js';
import type { SchnittZustand } from './schnittZustand.js';
import { useBearbeiteteVorschau, type Wischer } from './vorschau.js';
import { Zeitleiste, stellbildImFilm } from './Zeitleiste.js';

/**
 * Der Fotoeditor mit einer Zeitleiste darunter – bearbeiten und schneiden
 * an einem Ort.
 *
 * # Was man sieht
 *
 * Oben das Bild an der Wiedergabestelle – das STELLBILD –, mit allem, was
 * dort eingestellt ist, genau wie beim Foto. Darunter die Zeitleiste. Wer
 * darin einen anderen Abschnitt antippt, bearbeitet diesen; wer die
 * Wiedergabestelle verschiebt, bekommt beim Loslassen das Bild dort. Beim
 * Abspielen und Wischen liegt das laufende Video über dem Standbild, MIT
 * Bearbeitung (`vorschau.ts`).
 *
 * # Was an einem Bild zusammenkommt
 *
 * Zwei Dinge: die Bearbeitung des Abschnitts (Licht, Farbe, Zuschnitt) und
 * die Masken des FILMS (`masken.ts`). Eine Maske gehört nicht zu einem
 * Abschnitt, sondern gilt im ganzen Film oder in einem Zeitraum und wird
 * über die Bilder verfolgt; die Zeitleiste zeigt, wo sie zu sehen ist.
 * `bildDocAn` setzt für das Stellbild zusammen, was der Editor bekommt, und
 * `routen` verteilt jede Änderung zurück: die Bereiche an die Masken, den
 * Rest an den Abschnitt. Eine Maske, die an diesem Bild noch nicht verfolgt
 * ist, fehlt im Editor – und erscheint, sobald sie da ist.
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
  quelleUrl,
  kante,
  schrittMs,
  quelleMs,
  vorschau,
  name,
  onClose,
}: {
  schnitt: SchnittZustand;
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
  /*
   * Das Wischen kommt aus dem Wischspeicher (`wischspeicher.ts`): Wiedergabe
   * und Vorschau sprechen über `wischer`. Beim Loslassen springt das
   * sichtbare Video hier nicht – der Editor zeigt danach sein Standbild, und
   * der Dekodierer des Lesers soll es ohne Wettlauf holen.
   */
  const wischer = useRef<Wischer | null>(null);
  const wiedergabe = useFilmWiedergabe(videoRef, abschnitte, {
    filmBilder: schnitt.filmBilder,
    s: schrittMs,
    wischer,
    springenBeimLoslassen: false,
  });
  const [zieht, setZieht] = useState(false);

  /* ---------- Das Standbild ---------- */

  /*
   * Aus dem EINEN Dekodierer der Sitzung (`leserDienst.ts`), mit Vorfahrt:
   * Er springt einer nach dem anderen, und der Editor, der ein Bild zeigen
   * will, kommt vor jedem wartenden Auftrag der Verfolgung. Ein eigener
   * Leser daneben hielte auf einem Telefon einen zweiten Dekodierer fest.
   * Der Rand am Videoende ist die halbe Schrittweite, wie beim Filmbau –
   * sonst läge das Stellbild am Filmende auf einem anderen Bild als das,
   * das später gerechnet wird.
   */
  const { leser } = schnitt;

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
    const steuer = new AbortController();
    const holen = async () => {
      // An der Mitte des Rasterbildes – dort, wo auch Verfolgung und Filmbau
      // lesen. Nach einem Wechsel der Bildrate liegt `standMs` nicht mehr
      // unbedingt dort, und der Anker säße auf einem anderen Quellbild.
      const mitte = bildMitte(bildIndex(standMs, schrittMs), schrittMs);
      const lesung = await leser.holen(mitte, 'vorn', { voll: true, abbruch: steuer.signal });
      if (!lesung.voll) throw new Error('Das Standbild kam leer an');
      const blob = await alsPng(lesung.voll);
      const speicher = zwischenspeicher.current;
      speicher.set(standMs, blob);
      // Ein Dutzend genügt fürs Hin- und Herspringen; mehr hielte nur Speicher fest.
      if (speicher.size > 12) speicher.delete(speicher.keys().next().value as number);
      fertig(blob);
    };
    holen().catch((ausfall: unknown) => {
      if (gilt && !(ausfall instanceof AbbruchError)) {
        toast(errorMessage(ausfall, 'Das Standbild ging nicht'), 'error');
      }
    });
    return () => {
      gilt = false;
      // Ein Bild, das niemand mehr braucht, hält die Verfolgung nicht auf.
      steuer.abort();
    };
  }, [id, leser, schrittMs, standMs]);

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
  const [gezeigt, setGezeigt] = useState<Anzeige | null>(null);
  const { masken, spuren, speicher, mass } = schnitt;
  const rahmen = useMemo(
    () => (mass ? { abschnitte, s: schrittMs, b: mass.b, h: mass.h } : null),
    [abschnitte, mass, schrittMs],
  );
  /*
   * Die Masken über eine Referenz: Jede Änderung im Editor ändert sie, und
   * das Zusammensetzen soll davon nicht jedes Mal ausgelöst werden – nur bei
   * einem neuen Bild oder einem der Anlässe unter `fassung`.
   */
  const maskenJetzt = useRef(masken);
  maskenJetzt.current = masken;
  /**
   * Anlässe, dasselbe Bild neu zusammenzusetzen: Die Zeitleiste hat eine
   * Maske geändert (gelöscht, getrennt, eingegrenzt), eine Änderung aus dem
   * Editor wurde abgelehnt, oder eine Maske ist hier inzwischen verfolgt.
   * Ohne das zeigte der Editor eine gelöschte Maske weiter an – und die
   * nächste Reglerbewegung holte sie zurück.
   */
  const [neuLaden, setNeuLaden] = useState(0);
  const fassung = `${schnitt.leistenFassung}|${neuLaden}`;
  useEffect(() => {
    if (!abschnitt || !stillBereit || !standbild || !rahmen) return;
    const gleichesBild =
      gezeigt !== null && gezeigt.id === abschnitt.id && gezeigt.ms === abschnitt.standMs;
    if (gleichesBild && gezeigt.fassung === fassung) return;
    const k = bildIndex(abschnitt.standMs, schrittMs);
    const liste = maskenJetzt.current;
    const z = bildDocAn(abschnitt.doc, liste, spuren, k, 'editor', rahmen, speicher);
    if (z.fehlend.length > 0) spuren.vorziehen(k);
    setGezeigt({
      id: abschnitt.id,
      ms: abschnitt.standMs,
      /*
       * Dasselbe Bild in einer neuen Hülle: Der Editor lädt nur neu, wenn
       * sich sein Bild ändert. So bleibt es eine Sitzung – samt Rückgängig,
       * siehe `verlaufAnpassen` –, und das neue Dokument kommt trotzdem an.
       */
      blob: gleichesBild
        ? new Blob([standbild.blob], { type: standbild.blob.type })
        : standbild.blob,
      doc: z.doc,
      fassung,
      stand: { k, z, vorSitzung: liste },
    });
  }, [abschnitt, fassung, gezeigt, rahmen, schrittMs, speicher, spuren, standbild, stillBereit]);
  const bereit =
    gezeigt !== null &&
    abschnitt !== undefined &&
    gezeigt.id === abschnitt.id &&
    gezeigt.ms === abschnitt.standMs;
  const bereitRef = useRef(bereit);
  bereitRef.current = bereit;
  /*
   * Dasselbe Bild wird gerade neu zusammengesetzt (`fassung`): Der Editor
   * bleibt stehen und unverdeckt – ein Aufblitzen der Wiedergabe für ein
   * Neuladen, das niemand sieht, wäre nur Unruhe. Was er in diesem
   * Augenblick meldet, gehört aber noch zum alten Stand und wird verworfen.
   */
  const aktuellRef = useRef(true);
  aktuellRef.current = gezeigt?.fassung === fassung;

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
      if (!ziel) return;
      const neu = standImRaster(ziel, ort.quelleMs, schrittMs);
      /*
       * Verglichen wird Rasterbild mit Rasterbild, nicht mit dem gespeicherten
       * Stellbild: Nach einem Teilen liegt das auf dem Raster des GANZEN
       * Abschnitts, die Hälfte hat ihr eigenes – und dasselbe Bild galte
       * sonst als ein anderes.
       */
      if (Math.abs(neu - standImRaster(ziel, ziel.standMs, schrittMs)) < 0.5) return;
      // Das Stellbild wandert immer mit: Die Masken hängen nicht an ihm,
      // sie werden über den Film verfolgt.
      schnitt.standSetzen(ziel.id, neu);
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

  const ueberlagert = wiedergabe.spielt || zieht || !bereit;

  /* ---------- Die Verfolgung ---------- */

  /*
   * Sie ruht, solange ein Finger auf der Leiste liegt oder der Film läuft:
   * Beide brauchen den Dekodierer und die Rechenzeit, und ein Wischen, das
   * ruckelt, wiegt schwerer als eine Maske, die eine Sekunde später fertig
   * ist. Mit ihr ruht das Füllen des Wischspeichers (`schnitt.ruhen`): Das
   * Standbild beim Loslassen braucht den Dekodierer sofort.
   */
  const { ruhen } = schnitt;
  useEffect(() => {
    ruhen('zug', zieht);
  }, [ruhen, zieht]);
  useEffect(() => {
    ruhen('wiedergabe', wiedergabe.spielt);
  }, [ruhen, wiedergabe.spielt]);
  useEffect(
    () => () => {
      ruhen('zug', false);
      ruhen('wiedergabe', false);
    },
    [ruhen],
  );

  /*
   * Eine Maske, die am Stellbild noch fehlte (oder erst grob war), ist
   * inzwischen da: dann dasselbe Bild neu zusammensetzen. Geprüft wird nur,
   * wenn die Verfolgung etwas Neues meldet – höchstens viermal je Sekunde.
   *
   * Aber nur, solange im Editor seither nichts geändert wurde. Ein Neuladen
   * baut den Rückgängig-Verlauf um (`verlaufMitMasken`) – mitten in der
   * Arbeit nähme das die letzten Schritte an den Masken weg. Dann steht
   * statt dessen ein Knopf da, und der Anwender entscheidet.
   */
  const version = schnitt.spurstand.version;
  const [nachladbar, setNachladbar] = useState<{ fassung: string; namen: string[] } | null>(null);
  useEffect(() => {
    if (!gezeigt || !rahmen || !abschnitt || gezeigt.id !== abschnitt.id) return;
    const { k, z, vorSitzung } = gezeigt.stand;
    if (z.fehlend.length === 0 && z.grob.length === 0) return;
    const liste = maskenJetzt.current;
    const jetzt = bildDocAn(abschnitt.doc, liste, spuren, k, 'editor', rahmen, speicher);
    const gibtEs = (id: string) => liste.some((maske) => maske.id === id);
    const besser = [
      ...z.fehlend.filter((id) => gibtEs(id) && !jetzt.fehlend.includes(id)),
      ...z.grob.filter(
        (id) => gibtEs(id) && !jetzt.grob.includes(id) && !jetzt.fehlend.includes(id),
      ),
    ];
    if (besser.length === 0) return;
    if (liste === vorSitzung) {
      setNeuLaden((zahl) => zahl + 1);
      return;
    }
    const namen = besser
      .map((maskeId) => liste.find((maske) => maske.id === maskeId)?.name)
      .filter((name): name is string => Boolean(name));
    setNachladbar({ fassung: gezeigt.fassung, namen });
    // Nur die Meldung der Verfolgung löst das aus – siehe oben.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  /*
   * Ein Finger auf Bühne oder Werkzeugen lässt die Verfolgung ruhen – ein
   * Pinselstrich oder ein Tipp soll nicht auf ein Modell warten, das im
   * Hintergrund gerade rechnet. Die Zeitleiste meldet sich selbst (`zug`).
   */
  useEffect(() => {
    const an = (ereignis: PointerEvent) => {
      const ziel = ereignis.target instanceof Element ? ereignis.target : null;
      if (!ziel?.closest('.bild-editor') || ziel.closest('.bild-zeitleiste')) return;
      ruhen('finger', true);
    };
    const aus = () => ruhen('finger', false);
    document.addEventListener('pointerdown', an, true);
    document.addEventListener('pointerup', aus, true);
    document.addEventListener('pointercancel', aus, true);
    return () => {
      document.removeEventListener('pointerdown', an, true);
      document.removeEventListener('pointerup', aus, true);
      document.removeEventListener('pointercancel', aus, true);
      ruhen('finger', false);
    };
  }, [ruhen]);

  /* ---------- Die beiden Steckplätze ---------- */

  /*
   * Was über und unter der Bühne steht, lebt AUSSERHALB des Editors und wird
   * nur eingehängt – siehe oben.
   *
   * Das hat noch einen zweiten Grund: Beim ersten Öffnen steht der Editor
   * erst, wenn sein erstes Standbild da ist; bis dahin hängen Video und
   * Zeitleiste in einem schlichten Rahmen. Hingen sie im Editor selbst,
   * begänne das Video beim Wechsel von vorn zu laden, und die Zeitleiste
   * fiele auf ihren Anfangszustand zurück. (Ein Zug, der gerade läuft,
   * endet beim Umhängen trotzdem – siehe `verloren` in `Zeitleiste.tsx`.)
   */
  const ueberKnoten = useMemo(steckKnoten, []);
  const unterKnoten = useMemo(steckKnoten, []);
  const ueberBuehne = useMemo(() => <Steckplatz knoten={ueberKnoten} />, [ueberKnoten]);
  const unterBuehne = useMemo(() => <Steckplatz knoten={unterKnoten} />, [unterKnoten]);

  /* ---------- Das Video über der Bühne ---------- */

  /*
   * Die Vorschau zeigt das Video MIT der Bearbeitung des Abschnitts, in dem
   * das jeweilige Bild liegt, und mit den Masken des Films, so weit sie dort
   * verfolgt sind – siehe `vorschau.ts` und `filmDoc.ts`.
   */
  const leinwandRef = useRef<HTMLCanvasElement | null>(null);
  const [videoMass, setVideoMass] = useState<{ b: number; h: number } | null>(null);
  const lage = useRef({ spielt: false, nummer: 0, filmMs: 0 });
  lage.current = {
    spielt: wiedergabe.spielt,
    nummer: wiedergabe.nummer,
    filmMs: wiedergabe.spielkopfMs,
  };
  const { docFuer, docFuerBild } = useVorschauDoc(schnitt, lage);
  const neuZeichnen = useMemo(() => [abschnitte, masken, version], [abschnitte, masken, version]);
  const bearbeiteteVorschau = useBearbeiteteVorschau({
    video: videoRef,
    leinwand: leinwandRef,
    docFuer,
    docFuerBild,
    mass: videoMass,
    art: 'ansicht',
    aktiv: ueberlagert,
    schrittMs,
    neuZeichnen,
    speicher: schnitt.wisch,
    filmBilder: schnitt.filmBilder,
    wischer,
  });
  /** Gibt es eine eingeschaltete Maske, die noch nicht überall verfolgt ist? */
  const nochNichtUeberall = masken.some((maske) => {
    const stand = schnitt.spurstand.jeMaske.get(maske.id);
    return maske.aktiv && !stand?.fehler && (stand?.anteil ?? 0) < 1;
  });

  /*
   * Was über dem Bild steht, in dieser Reihenfolge: das Gerät ist zu
   * langsam, der Speicher ist noch nicht gefüllt, eine Maske fehlt gerade an
   * DIESEM Bild.
   */
  const fehlendNamen = bearbeiteteVorschau.fehlend
    .map((maskeId) => masken.find((maske) => maske.id === maskeId)?.name)
    .filter((eintrag): eintrag is string => Boolean(eintrag));
  const { wischStand } = schnitt;
  const zeile =
    wiedergabe.spielt && bearbeiteteVorschau.guete === 2 ? (
      <div className="bild-wiedergabe-zeile">
        <span>
          Wiedergabe ohne Bearbeitung – dieses Gerät ist dafür zu langsam. Angehalten und beim
          Wischen siehst du sie.
        </span>
      </div>
    ) : zieht && bearbeiteteVorschau.notstufe ? (
      <div className="bild-wiedergabe-zeile">
        <span>
          Dieses Gerät ist zum Wischen mit Bearbeitung zu langsam – sie erscheint, sobald du
          anhältst.
        </span>
      </div>
    ) : zieht && wischStand.verfuegbar && wischStand.von > 0 && wischStand.stufe < 2 ? (
      <div className="bild-wiedergabe-zeile">
        <span>
          Die Wischvorschau wird noch vorbereitet (
          {Math.round((100 * wischStand.bilder) / wischStand.von)} %) – bis dahin läuft sie
          ruckliger.
        </span>
      </div>
    ) : zieht && bearbeiteteVorschau.bearbeitet && fehlendNamen.length > 0 ? (
      <div className="bild-wiedergabe-zeile">
        <span>
          {aufzaehlen(fehlendNamen)} {fehlendNamen.length === 1 ? 'wird' : 'werden'} an diesem Bild
          noch verfolgt und {fehlendNamen.length === 1 ? 'erscheint' : 'erscheinen'} kurz nach dem
          Loslassen.
        </span>
      </div>
    ) : wiedergabe.spielt && bearbeiteteVorschau.bearbeitet && nochNichtUeberall ? (
      <div className="bild-wiedergabe-zeile">
        <span>Wo eine Maske noch verfolgt wird, fehlt sie hier noch.</span>
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
          className={`bild-wiedergabe-video${bearbeiteteVorschau.bearbeitet ? ' ist-verdeckt' : ''}`}
          onLoadedMetadata={(ereignis) => {
            const element = ereignis.currentTarget;
            setVideoMass(masse(element.videoWidth, element.videoHeight, kante));
          }}
        />
        {/*
            Über dem Video, nicht statt seiner: Das Video muss weiter
            angezeigt werden (nur unsichtbar), sonst meldet es keine Bilder
            mehr – und es ist der Rückfall, wenn das Gerät zu langsam ist.
        */}
        <canvas
          ref={leinwandRef}
          className="bild-wiedergabe-bild"
          hidden={!bearbeiteteVorschau.bearbeitet}
          aria-hidden="true"
        />
      </div>
      {zeile}
    </div>
  );

  /* ---------- Die Masken in der Zeitleiste ---------- */

  const maskenLeiste: MaskenLeiste = {
    masken,
    gewaehlt: schnitt.gewaehlt,
    quelle: spuren,
    version,
    jeMaske: schnitt.spurstand.jeMaske,
    mass,
    zurueckMoeglich: schnitt.leisteZurueckMoeglich,
    onWaehlen: schnitt.waehlen,
    onGeltung: schnitt.geltungSetzen,
    onAn: schnitt.maskeAn,
    onLoeschen: schnitt.maskeLoeschen,
    onTrennen: schnitt.maskeTrennen,
    onZurueck: schnitt.leisteZurueck,
    onZurueckHalten: schnitt.leisteZurueckHalten,
    onGriffZug: (filmMs, fertig) => {
      // Das Video folgt dem Griff, und beim Loslassen steht das Stellbild
      // dort – man sieht, wo die Maske jetzt anfängt oder endet.
      if (wiedergabe.spielt) wiedergabe.anhalten();
      wiedergabe.wischen(filmMs, fertig);
      setZieht(!fertig);
      if (fertig) ankommen(filmMs);
    },
  };

  /*
   * Was über die Masken an DIESEM Bild zu sagen ist – eine Zeile über der
   * Zeitleiste, solange der Editor zu sehen ist.
   */
  const maskenLage = (() => {
    if (!gezeigt || ueberlagert) return null;
    const { z } = gezeigt.stand;
    if (nachladbar && nachladbar.fassung === gezeigt.fassung) {
      return (
        <p className="mb-lage" role="status">
          {aufzaehlen(nachladbar.namen)} {nachladbar.namen.length === 1 ? 'ist' : 'sind'} hier
          inzwischen verfolgt.
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setNachladbar(null);
              setNeuLaden((zahl) => zahl + 1);
            }}
          >
            Zeigen
          </button>
        </p>
      );
    }
    const namen = (ids: readonly string[]) =>
      aufzaehlen(
        ids
          .map((maskeId) => masken.find((maske) => maske.id === maskeId)?.name)
          .filter((name): name is string => Boolean(name)),
      );
    const fehlendAlle = z.fehlend.filter((maskeId) => masken.some((maske) => maske.id === maskeId));
    // Eine Kette, die gescheitert ist, rechnet nicht noch einmal – das
    // sagen, statt für immer „wird verfolgt" zu drehen.
    const gescheitert = fehlendAlle
      .map((maskeId) => ({
        name: masken.find((maske) => maske.id === maskeId)?.name ?? '',
        fehler: schnitt.spurstand.jeMaske.get(maskeId)?.fehler,
      }))
      .filter((eintrag) => eintrag.fehler);
    if (gescheitert.length > 0) {
      return (
        <p className="mb-lage mb-hinweis" role="status">
          „{gescheitert[0].name}": {gescheitert[0].fehler}
        </p>
      );
    }
    if (z.jenseits.length > 0 && fehlendAlle.length === 0) {
      return (
        <p className="mb-lage" role="status">
          Dieses Bild liegt hinter dem Ende des fertigen Films (höchstens {MAX_BILDER_FILM} Bilder)
          – hier wird nicht verfolgt.
        </p>
      );
    }
    const fehlend = fehlendAlle;
    if (fehlend.length > 0) {
      return (
        <p className="mb-lage" role="status">
          <span className="spinner" aria-hidden="true" />
          {namen(fehlend)} {fehlend.length === 1 ? 'wird' : 'werden'} an diesem Bild noch verfolgt
          und {fehlend.length === 1 ? 'erscheint' : 'erscheinen'}, sobald es so weit ist.
        </p>
      );
    }
    const grob = z.grob.filter((maskeId) => masken.some((maske) => maske.id === maskeId));
    if (grob.length > 0) {
      return (
        <p className="mb-lage" role="status">
          {namen(grob)} {grob.length === 1 ? 'ist' : 'sind'} hier erst grob verfolgt – genauer folgt
          gleich.
        </p>
      );
    }
    const gewaehlt = masken.find((maske) => maske.id === schnitt.gewaehlt);
    if (gewaehlt && z.enthalten.has(gewaehlt.id) && gewaehlt.geltung.art === 'ganz') {
      return (
        <p className="mb-lage">
          „{gewaehlt.name}“ gilt im ganzen Film – Änderungen wirken überall. In der Zeitleiste lässt
          sie sich trennen.
        </p>
      );
    }
    const laufend = masken
      .map((maske) => schnitt.spurstand.jeMaske.get(maske.id))
      .filter((stand) => stand?.laeuft);
    if (laufend.length > 0) {
      const anteil = Math.min(...laufend.map((stand) => stand?.anteil ?? 0));
      const rest = restText(Math.max(...laufend.map((stand) => stand?.restMs ?? 0)));
      return (
        <p className="mb-lage" role="status">
          <span className="spinner" aria-hidden="true" />
          Masken werden verfolgt · {Math.round(anteil * 100)} %{rest && ` · ${rest}`}
        </p>
      );
    }
    return null;
  })();

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
      stellbildMs={stellbildImFilm(abschnitte, aktiv)}
      masken={maskenLeiste}
      onSpielkopf={(filmMs, fertig) => {
        wiedergabe.wischen(filmMs, fertig);
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
        if (!fertig) {
          // Beim Ziehen zeigt die Vorschau die Kante, an der man gerade ist – aus dem
          // Wischspeicher, wo er sie hat, sonst springt das Video dorthin.
          setZieht(true);
          const alt = abschnitte[nummer];
          if (alt) {
            const von = vonMs !== alt.vonMs;
            wiedergabe.zeigeKante(nummer, von ? vonMs : bisMs, von ? 'von' : 'bis');
          }
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
  const { routen } = schnitt;
  const aenderung = useCallback(
    (doc: BildDoc, herkunft: { quelle: Blob; sitzung?: string }) => {
      // Nur, solange Bild, Dokument und Abschnitt zusammenpassen – siehe
      // `gezeigt` –, und nur für ein Dokument, das zu diesem Bild geladen
      // wurde, nicht für das vorige, das beim Laden noch dasteht.
      if (!bereitRef.current || !aktuellRef.current || !gezeigt) return;
      if (herkunft.quelle !== gezeigt.blob || herkunft.sitzung !== gezeigt.id) return;
      const erg = routen(doc, gezeigt.stand, gezeigt.id);
      if (erg.abgelehnt) {
        // Der Editor zeigt, was abgelehnt wurde – also neu laden, was gilt.
        toast(erg.abgelehnt, 'info');
        setNeuLaden((zahl) => zahl + 1);
      }
    },
    [gezeigt, routen],
  );
  /*
   * Wie viele Bereiche der Editor noch anlegen darf: An einem Bild wirken
   * höchstens vier Masken, im Film höchstens acht – und eine neue Maske
   * gilt zunächst im ganzen Film, also auch dort, wo schon vier wirken.
   */
  const platz = useMemo(
    () =>
      gezeigt ? bereichePlatz(masken, gezeigt.stand, { abschnitte, s: schrittMs }) : undefined,
    [abschnitte, gezeigt, masken, schrittMs],
  );
  const schliessenRef = useRef(onClose);
  schliessenRef.current = onClose;
  const schliessen = useCallback(() => schliessenRef.current(), []);

  return (
    <>
      {/*
          Die beiden Steckplatz-Inhalte in einem Portal an `document.body`,
          wie der Editor selbst. Ohne diese Hülle fände React über ihnen
          keinen Behälter an `body`, hielte den Knoten für eine eigene Wurzel
          und reichte jedes Ereignis aus Leiste und Wiedergabe ZWEIMAL an die
          Vorfahren weiter – harmlos, solange dort niemand zählt oder
          umschaltet, aber eine Falle für den Nächsten, der es tut.
      */}
      {createPortal(
        <>
          {createPortal(wiedergabeFlaeche, ueberKnoten)}
          {createPortal(
            <>
              {maskenLage}
              {zeitleiste}
            </>,
            unterKnoten,
          )}
        </>,
        document.body,
      )}
      {gezeigt ? (
        <RuhigerEditor
          quelle={gezeigt.blob}
          sitzung={gezeigt.id}
          startDoc={gezeigt.doc}
          name={name ?? null}
          ohneEntwurf
          titel={titel}
          gesperrt={!bereit}
          bereicheMax={platz?.max}
          bereicheGrund={platz?.grund}
          verlaufAnpassen={verlaufMitMasken}
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

/** Was der Editor gerade zeigt – Bild, Dokument und Abschnitt, siehe oben. */
interface Anzeige {
  readonly id: string;
  readonly ms: number;
  /** Was der Editor als Bild bekommt – nach einem Neuladen eine neue Hülle. */
  readonly blob: Blob;
  readonly doc: BildDoc;
  /** Für welche `fassung` zusammengesetzt wurde. */
  readonly fassung: string;
  readonly stand: Gezeigt;
}

/**
 * Der Rückgängig-Verlauf über einen Bildwechsel: Jeder alte Stand behält
 * Licht, Farbe und Zuschnitt, bekommt aber die Masken des neuen Bildes.
 *
 * Die Masken eines alten Stands gehörten zu einem anderen Bild; über dieses
 * gelegt, sässen sie falsch. Und sie zurückzuholen hiesse für `routen`
 * nichts: Die Teile sind dieselben wie ausgegeben, also bleibt alles, wie es
 * ist.
 */
function verlaufMitMasken(eintrag: BildDoc, neu: BildDoc): BildDoc {
  return { ...eintrag, bereiche: neu.bereiche };
}

/** „A", „A und B", „A, B und C" – mit Anführungszeichen. */
function aufzaehlen(namen: readonly string[]): string {
  const mit = namen.map((name) => `„${name}“`);
  if (mit.length <= 1) return mit[0] ?? '';
  return `${mit.slice(0, -1).join(', ')} und ${mit[mit.length - 1]}`;
}

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
