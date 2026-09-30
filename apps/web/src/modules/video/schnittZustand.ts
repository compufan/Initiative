import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { docUnberuehrt, type BildDoc } from '../bild/doc.js';
import { toast } from '../../state/ui.js';
import { MAX_BILDER_FILM } from './einstellungen.js';
import {
  GELOESCHT_MAX,
  Kompositspeicher,
  ankerEntfernen as ankerEntfernenRein,
  bereicheUmwandeln,
  editorAenderung,
  grenzeVerletzt,
  maskeTrennen as maskeTrennenRein,
  maskenUmrastern,
  type Geltung,
  type Gezeigt,
  type Maske,
} from './masken.js';
import { leserDienst, type Leserdienst } from './leserDienst.js';
import { filmRaster } from './raster.js';
import { leereSpuren, spurdienstFuer, type Spurdienst, type Spurstand } from './spurdienst.js';
import {
  abschnittDazu,
  abschnittEntfernen,
  abschnittKennung,
  abschnittKuerzen,
  abschnittTeilen,
  abschnittVerschieben,
  ersterAbschnitt,
  rasterNeu,
  verlegungVermerken,
  type Abschnitt,
} from './schnitt.js';

/**
 * Die Abschnitte eines Films samt allem, was an ihnen gerechnet wird.
 *
 * Ein Haken für das Blatt UND den Editor: Beide zeigen dieselbe Zeitleiste,
 * und ein Schnitt im Editor muss im Blatt stehen, sobald man zurückkommt.
 *
 * # Was hier im Hintergrund läuft
 *
 * Die Verfolgung der Masken (`spurdienst.ts`). Eine Maske gehört nicht zu
 * einem Abschnitt, sondern zum Film: Sie gilt überall oder in einem
 * Zeitraum, und die Verfolgung rechnet aus, wo ihr Gegenstand an jedem Bild
 * liegt. Schneiden, Teilen und Umstellen kosten dabei nichts – verfolgt
 * wird in Bildern des Videos, nicht des Films.
 *
 * Früher hing jede Maske an EINEM Bild ihres Abschnitts und wurde beim
 * Verschieben des Stellbildes erst dorthin „mitgenommen"; währenddessen
 * drehte sich ein Kreisel. Das gibt es nicht mehr: Das Stellbild wandert
 * frei, und was an ihm zu sehen ist, setzt `bildDocAn` zusammen.
 */
export interface SchnittZustand {
  readonly abschnitte: readonly Abschnitt[];
  readonly aktiv: number;
  /** Der Bildabstand des Films – das Raster, auf dem die Masken stehen. */
  readonly s: number;
  /** Die Rechengrösse – darin stehen Dokumente und Masken. */
  readonly mass: { readonly b: number; readonly h: number } | null;
  setAktiv(nummer: number): void;
  /** Mit dem ganzen Video (höchstens `bisMs`) neu anfangen. */
  anfangen(bisMs: number): void;
  teilen(nummer: number, beiMs: number): boolean;
  kuerzen(nummer: number, vonMs: number, bisMs: number): void;
  verschieben(richtung: -1 | 1): void;
  entfernen(): void;
  dazu(): void;
  /** Die Bearbeitung eines Abschnitts ersetzen – jede Änderung aus dem Editor. */
  docSetzen(id: string, doc: BildDoc): void;
  /** Das Stellbild versetzen – das Bild, das der Editor zeigt. */
  standSetzen(id: string, ms: number): void;
  /** Alle Bearbeitungen weg – nach einem Wechsel der Rechengrösse. */
  alleVerwerfen(): void;

  /* ---------- Die Masken des Films (masken.ts) ---------- */

  /**
   * Die Masken – nicht mehr je Abschnitt, sondern als Spuren über den Film.
   * Wo eine gilt, sagt ihre `geltung`; wo sie zu sehen ist, die Verfolgung.
   */
  readonly masken: readonly Maske[];
  /** Die Maske, die in der Zeitleiste gewählt ist. */
  readonly gewaehlt: string | null;
  /** Die Verfolgung – liefert, was an einem Bild von jeder Maske bekannt ist. */
  readonly spuren: Spurdienst;
  /**
   * Der eine Dekodierer der Sitzung – für die Stellbilder des Editors
   * (`'vorn'`) und die Verfolgung (`'hinten'`), siehe `leserDienst.ts`.
   */
  readonly leser: Leserdienst;
  readonly spurstand: Spurstand;
  /** Geteilt von Editor und Vorschau: dieselben Teile für dasselbe Bild. */
  readonly speicher: Kompositspeicher;
  /**
   * Steigt, wenn die Zeitleiste eine Maske geändert hat. Der Editor lädt sein
   * Bild dann neu – sonst zeigte er eine gelöschte Maske weiter an.
   */
  readonly leistenFassung: number;
  /** Lässt sich die letzte Änderung aus der Zeitleiste zurücknehmen? */
  readonly leisteZurueckMoeglich: boolean;
  waehlen(id: string | null): void;
  /**
   * Eine Änderung aus dem Editor verteilen: der Rest an den Abschnitt, die
   * Bereiche an die Masken (siehe `editorAenderung`).
   */
  routen(neu: BildDoc, gezeigt: Gezeigt, abschnittId: string): { abgelehnt?: string };
  /** `fertig: false` während eines Zugs am Griff – nur zum Zeichnen. */
  geltungSetzen(id: string, geltung: Geltung, fertig: boolean): boolean;
  maskeAn(id: string, aktiv: boolean): void;
  maskeLoeschen(id: string): void;
  maskeTrennen(id: string, filmMs: number): void;
  ankerEntfernen(id: string, k: number): void;
  leisteZurueck(): void;
}

export interface SchnittAuftrag {
  readonly datei: Blob;
  readonly kante: number;
  readonly schrittMs: number;
  readonly quelleMs: number;
  /** Die Rechengrösse – daran misst sich, ob ein Dokument überhaupt etwas tut. */
  readonly mass: { b: number; h: number } | null;
}

export function useSchnitt(auftrag: SchnittAuftrag): SchnittZustand {
  const { datei, kante, schrittMs, quelleMs, mass } = auftrag;
  const [abschnitte, setAbschnitte] = useState<readonly Abschnitt[]>([]);
  const [aktiv, setAktivRoh] = useState(0);
  const liste = useRef(abschnitte);
  liste.current = abschnitte;

  /*
   * Die Masken leben in einer Referenz UND im Zustand.
   *
   * Die Referenz wird sofort gesetzt, nicht erst nach dem nächsten Zeichnen:
   * Der Editor meldet bei einem Zug mehrere Änderungen hintereinander, und
   * jede muss die vorige sehen – sonst überschriebe die zweite die erste.
   * Und die Rückruf-Funktionen, die davon lesen, bleiben dieselben; der
   * Editor (4400 Zeilen) rechnet deshalb nicht bei jedem Reglerschritt neu.
   */
  const [masken, setMaskenRoh] = useState<readonly Maske[]>([]);
  const maskenRef = useRef(masken);
  const setMasken = useCallback((neu: readonly Maske[]) => {
    if (neu === maskenRef.current) return;
    maskenRef.current = neu;
    setMaskenRoh(neu);
  }, []);
  /** Gelöschte Masken, damit ein Rückgängig im Editor sie mit ihren Spuren zurückholt. */
  const geloeschtRef = useRef<ReadonlyMap<string, Maske>>(new Map());
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [leistenFassung, setLeistenFassung] = useState(0);
  const [leisteZurueckMoeglich, setLeisteZurueckMoeglich] = useState(false);
  const vorLeiste = useRef<readonly Maske[] | null>(null);
  const zugAnfang = useRef<readonly Maske[] | null>(null);
  const speicher = useMemo(() => new Kompositspeicher(), []);

  /*
   * Die Verfolgung – EINE je Video, Rechengrösse und Bildraster. Ändert sich
   * eines davon, stimmt keine gerechnete Spur mehr; die Masken bleiben, ihre
   * Spuren werden neu gerechnet.
   */
  const massB = mass?.b ?? 0;
  const massH = mass?.h ?? 0;
  /** Dieselbe Angabe, solange sich die Zahlen nicht ändern – sie steckt in Abhängigkeiten. */
  const rahmenMass = useMemo(
    () => (massB > 0 && massH > 0 ? { b: massB, h: massH } : null),
    [massB, massH],
  );
  const leser = useMemo(() => leserDienst(datei, kante, schrittMs), [datei, kante, schrittMs]);
  useEffect(() => () => leser.schliessen(), [leser]);
  /*
   * Angelegt in einem Effekt, nicht in `useMemo`: Der Verfolger rechnet ab
   * seiner Geburt und muss geschlossen werden. Aus `useMemo` käme im
   * Entwicklungsmodus (StrictMode) ein zweiter, der nie geschlossen wird,
   * und das Aufräumen des Probedurchlaufs schlösse den, der bleibt. Bis der
   * Effekt gelaufen ist, gilt der leere – einen Augenblick lang.
   *
   * Ein verborgenes Fenster meldet der Verfolger selbst.
   */
  const [spuren, setSpuren] = useState<Spurdienst>(leereSpuren);
  useEffect(() => {
    const dienst = spurdienstFuer({ leser, s: schrittMs, mass: rahmenMass });
    setSpuren(dienst);
    return () => dienst.schliessen();
  }, [leser, schrittMs, rahmenMass]);
  const spurstand = useSyncExternalStore(spuren.abonnieren, spuren.stand, spuren.stand);
  useEffect(() => {
    spuren.setzen(masken, abschnitte, filmRaster(abschnitte, schrittMs, MAX_BILDER_FILM).menge);
  }, [abschnitte, masken, schrittMs, spuren]);

  /*
   * Bereiche, die noch in einem Abschnittsdokument stehen, werden Masken.
   *
   * Das kommt nur aus einer Sitzung, die über eine Aktualisierung hinweg
   * offen war (oder aus einem Aufrufer, der noch Dokumente mit Bereichen
   * hereinreicht): Der Editor liefert Bereiche seit den Maskenspuren nie
   * mehr an einen Abschnitt.
   */
  useEffect(() => {
    if (!abschnitte.some((abschnitt) => (abschnitt.doc?.bereiche.length ?? 0) > 0)) return;
    const erg = bereicheUmwandeln(abschnitte, maskenRef.current, schrittMs, mass ?? undefined);
    setAbschnitte(erg.abschnitte);
    setMasken(erg.masken);
    if (erg.verworfen > 0) {
      toast(
        `${erg.verworfen} ${erg.verworfen === 1 ? 'Bereich passte' : 'Bereiche passten'} nicht mehr in den Film – höchstens 4 Masken wirken an einem Bild.`,
        'info',
      );
    }
  }, [abschnitte, mass, schrittMs, setMasken]);

  const setAktiv = useCallback((nummer: number) => {
    setAktivRoh(Math.max(0, Math.min(nummer, liste.current.length - 1)));
  }, []);

  /*
   * Die Schrittweite über eine Referenz: Das Blatt ruft `anfangen` aus einem
   * Effekt, der nur am Video hängt, und hält damit die Fassung vom ersten
   * Zeichnen fest. Wählt jemand die Bildrate, bevor das Video gelesen ist,
   * lägen die Kanten des ersten Abschnitts sonst auf dem ALTEN Raster – und
   * das Umrastern unten wäre dann schon gelaufen, auf einer leeren Liste.
   */
  const schrittRef = useRef(schrittMs);
  schrittRef.current = schrittMs;
  const anfangen = useCallback((bisMs: number) => {
    setAbschnitte([ersterAbschnitt(bisMs, schrittRef.current, abschnittKennung())]);
    setAktivRoh(0);
  }, []);

  /*
   * Eine neue Bildrate legt alle Kanten auf IHR Raster – siehe `raster.ts`.
   *
   * Hier und nicht im Blatt, das die Bildrate wählt: Dort hinge es an jedem
   * Knopf, der sie ändert, und ein vergessener liesse Kanten auf dem alten
   * Raster zurück. Die Länge der Quelle kommt über eine Referenz herein – sie
   * zu einer Abhängigkeit zu machen, rasterte bei jedem Laden neu, obwohl
   * sich nur das Raster ändern kann.
   */
  const quelleRef = useRef(quelleMs);
  quelleRef.current = quelleMs;
  const schrittVorher = useRef(schrittMs);
  useEffect(() => {
    // Die Masken stehen in Rasterbildern – mit dem Raster rücken sie mit.
    if (schrittVorher.current !== schrittMs) {
      setMasken(maskenUmrastern(maskenRef.current, schrittVorher.current, schrittMs));
      schrittVorher.current = schrittMs;
    }
    setAbschnitte((alt) => {
      const erg = rasterNeu(alt, schrittMs, quelleRef.current);
      return erg.verlegungen.reduce(
        (liste, verlegung) => verlegungVermerken(liste, verlegung),
        erg.abschnitte,
      );
    });
  }, [schrittMs]);

  const teilen = useCallback(
    (nummer: number, beiMs: number) => {
      const erg = abschnittTeilen(liste.current, nummer, beiMs, schrittMs);
      if (!erg) return false;
      setAbschnitte(verlegungVermerken(erg.abschnitte, erg.verlegung));
      // Gewählt bleibt die Hälfte, in der die Wiedergabestelle jetzt steht –
      // die hintere, denn geteilt wird genau dort, wo sie steht.
      setAktivRoh(nummer + 1);
      return true;
    },
    [schrittMs],
  );

  const kuerzen = useCallback(
    (nummer: number, vonMs: number, bisMs: number) => {
      const erg = abschnittKuerzen(liste.current, nummer, vonMs, bisMs, quelleMs, schrittMs);
      setAbschnitte(verlegungVermerken(erg.abschnitte, erg.verlegung));
    },
    [quelleMs, schrittMs],
  );

  const verschieben = useCallback(
    (richtung: -1 | 1) => {
      const neu = abschnittVerschieben(liste.current, aktiv, richtung);
      if (neu === liste.current) return;
      setAbschnitte(neu);
      setAktivRoh(aktiv + richtung);
    },
    [aktiv],
  );

  const entfernen = useCallback(() => {
    const neu = abschnittEntfernen(liste.current, aktiv);
    if (neu === liste.current) return;
    setAbschnitte(neu);
    setAktivRoh(Math.max(0, Math.min(aktiv, neu.length - 1)));
  }, [aktiv]);

  const dazu = useCallback(() => {
    const erg = abschnittDazu(liste.current, aktiv, quelleMs, schrittMs);
    setAbschnitte(verlegungVermerken(erg.abschnitte, erg.verlegung));
    setAktivRoh(erg.neu);
  }, [aktiv, quelleMs, schrittMs]);

  const docSetzen = useCallback(
    (id: string, doc: BildDoc) => {
      /*
       * Ein Dokument, das nichts tut, wird zu `null`.
       *
       * Der Editor legt beim Öffnen eines unbearbeiteten Abschnitts ein
       * frisches Dokument an und meldet es sofort. Ohne diese Prüfung trüge
       * danach jeder Abschnitt, den jemand nur angesehen hat, das Zeichen
       * „bearbeitet".
       */
      const wirkt = !(mass && docUnberuehrt(doc, mass.b, mass.h));
      setAbschnitte((alt) => {
        let geaendert = false;
        const neu = alt.map((abschnitt) => {
          if (abschnitt.id !== id) return abschnitt;
          const neuesDoc = wirkt ? doc : null;
          if (abschnitt.doc === neuesDoc) return abschnitt;
          geaendert = true;
          // Was jetzt eingestellt wird, gehört zum Stellbild – eine noch
          // offene Mitnahme ist damit gegenstandslos.
          const { teileMs: _weg, ...ohne } = abschnitt;
          return { ...ohne, doc: neuesDoc };
        });
        // Dieselbe Liste, wenn sich nichts geändert hat – sonst rechnete
        // alles, was an ihr hängt, für nichts neu.
        return geaendert ? neu : alt;
      });
    },
    [mass],
  );

  const standSetzen = useCallback((id: string, ms: number) => {
    setAbschnitte((alt) => {
      const abschnitt = alt.find((eintrag) => eintrag.id === id);
      if (!abschnitt || abschnitt.standMs === ms) return alt;
      const versetzt = alt.map((eintrag) =>
        eintrag.id === id ? { ...eintrag, standMs: ms } : eintrag,
      );
      return verlegungVermerken(versetzt, { id, vonMs: abschnitt.standMs, nachMs: ms });
    });
  }, []);

  const alleVerwerfen = useCallback(() => {
    setAbschnitte((alt) =>
      alt.map((abschnitt) => {
        const { teileMs: _weg, ...ohne } = abschnitt;
        return { ...ohne, doc: null };
      }),
    );
    setMasken([]);
    geloeschtRef.current = new Map();
    vorLeiste.current = null;
    setLeisteZurueckMoeglich(false);
    setGewaehlt(null);
    speicher.leeren();
  }, [setMasken, speicher]);

  /* ---------- Masken ---------- */

  const bezug = useCallback(() => ({ abschnitte: liste.current, s: schrittMs }), [schrittMs]);

  const routen = useCallback(
    (neu: BildDoc, gezeigt: Gezeigt, abschnittId: string): { abgelehnt?: string } => {
      const erg = editorAenderung(neu, gezeigt, maskenRef.current, geloeschtRef.current, bezug());
      docSetzen(abschnittId, erg.clipDoc);
      if (erg.abgelehnt) return { abgelehnt: erg.abgelehnt };
      geloeschtRef.current = erg.geloescht;
      setMasken(erg.masken);
      if (erg.neu.length > 0) setGewaehlt(erg.neu[erg.neu.length - 1]);
      return {};
    },
    // `docSetzen` ist stabil genug: Es hängt nur an der Rechengrösse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bezug, setMasken],
  );

  /** Eine Änderung aus der Zeitleiste – mit einem Schritt zurück für zehn Sekunden. */
  const zurueckUhr = useRef<number | null>(null);
  const leisteAendern = useCallback(
    (neu: readonly Maske[], vorher: readonly Maske[] = maskenRef.current) => {
      if (neu === maskenRef.current) return;
      vorLeiste.current = vorher;
      setMasken(neu);
      setLeistenFassung((fassung) => fassung + 1);
      setLeisteZurueckMoeglich(true);
      if (zurueckUhr.current !== null) window.clearTimeout(zurueckUhr.current);
      zurueckUhr.current = window.setTimeout(() => {
        vorLeiste.current = null;
        setLeisteZurueckMoeglich(false);
      }, 10_000);
    },
    [setMasken],
  );
  useEffect(
    () => () => {
      if (zurueckUhr.current !== null) window.clearTimeout(zurueckUhr.current);
    },
    [],
  );

  const geltungSetzen = useCallback(
    (id: string, geltung: Geltung, fertig: boolean): boolean => {
      const alt = maskenRef.current;
      const neu = alt.map((maske) => {
        if (maske.id !== id) return maske;
        // Wer auf „ganzer Film" geht, soll seinen Zeitraum mit einem Tipp
        // zurückbekommen – `zuletzt` merkt ihn sich.
        const zuletzt =
          geltung.art === 'ganz' && maske.geltung.art !== 'ganz' ? maske.geltung : maske.zuletzt;
        return { ...maske, geltung, ...(zuletzt ? { zuletzt } : {}) };
      });
      const fehler = grenzeVerletzt(neu, bezug());
      if (fehler) {
        if (fertig) toast(fehler, 'info');
        return false;
      }
      if (!fertig) {
        // Während des Zugs nur zeichnen; zurück geht es an den Anfang des Zugs.
        zugAnfang.current ??= alt;
        setMasken(neu);
        return true;
      }
      leisteAendern(neu, zugAnfang.current ?? alt);
      zugAnfang.current = null;
      return true;
    },
    [bezug, leisteAendern, setMasken],
  );

  const maskeAn = useCallback(
    (id: string, aktiv: boolean) => {
      const alt = maskenRef.current;
      const neu = alt.map((maske) => (maske.id === id ? { ...maske, aktiv } : maske));
      if (aktiv) {
        const fehler = grenzeVerletzt(neu, bezug());
        if (fehler) {
          toast(fehler, 'info');
          return;
        }
      }
      leisteAendern(neu);
    },
    [bezug, leisteAendern],
  );

  const maskeLoeschen = useCallback(
    (id: string) => {
      const alt = maskenRef.current;
      const maske = alt.find((eintrag) => eintrag.id === id);
      if (!maske) return;
      const geloescht = new Map(geloeschtRef.current);
      geloescht.set(id, maske);
      while (geloescht.size > GELOESCHT_MAX) geloescht.delete(geloescht.keys().next().value!);
      geloeschtRef.current = geloescht;
      leisteAendern(alt.filter((eintrag) => eintrag.id !== id));
      setGewaehlt((jetzt) => (jetzt === id ? null : jetzt));
    },
    [leisteAendern],
  );

  const maskeTrennen = useCallback(
    (id: string, filmMs: number) => {
      const erg = maskeTrennenRein(maskenRef.current, id, bezug(), filmMs);
      if ('abgelehnt' in erg) {
        toast(erg.abgelehnt, 'info');
        return;
      }
      leisteAendern(erg.masken);
      setGewaehlt(erg.neu);
    },
    [bezug, leisteAendern],
  );

  const ankerEntfernen = useCallback(
    (id: string, k: number) => {
      leisteAendern(ankerEntfernenRein(maskenRef.current, id, k));
    },
    [leisteAendern],
  );

  const leisteZurueck = useCallback(() => {
    const vorher = vorLeiste.current;
    if (!vorher) return;
    vorLeiste.current = null;
    setMasken(vorher);
    setLeistenFassung((fassung) => fassung + 1);
    setLeisteZurueckMoeglich(false);
  }, [setMasken]);

  // Eine Maske, die es nicht mehr gibt, ist auch nicht mehr gewählt.
  const gewaehltGilt = gewaehlt !== null && masken.some((maske) => maske.id === gewaehlt);

  return {
    abschnitte,
    aktiv: Math.min(aktiv, Math.max(0, abschnitte.length - 1)),
    s: schrittMs,
    mass: rahmenMass,
    setAktiv,
    anfangen,
    teilen,
    kuerzen,
    verschieben,
    entfernen,
    dazu,
    docSetzen,
    standSetzen,
    alleVerwerfen,
    masken,
    gewaehlt: gewaehltGilt ? gewaehlt : null,
    spuren,
    leser,
    spurstand,
    speicher,
    leistenFassung,
    leisteZurueckMoeglich,
    waehlen: setGewaehlt,
    routen,
    geltungSetzen,
    maskeAn,
    maskeLoeschen,
    maskeTrennen,
    ankerEntfernen,
    leisteZurueck,
  };
}
