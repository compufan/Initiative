import { useCallback, useEffect, useRef, useState } from 'react';

import { docUnberuehrt, type BildDoc } from '../bild/doc.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from '../media/helpers.js';
import { AbbruchError } from '../stickers/engines/index.js';
import {
  abschnittDazu,
  abschnittEntfernen,
  abschnittKennung,
  abschnittKuerzen,
  abschnittTeilen,
  abschnittVerschieben,
  haengtAmBild,
  mussVerlegen,
  standImRaster,
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
 * Die Mitnahme der Masken (`verlegen.ts`). Wer einen freigestellten
 * Abschnitt teilt, hat danach eine Hälfte, deren Stellbild woanders liegt
 * als das Bild, zu dem ihre Maske gehört. Die Maske wird dorthin verfolgt –
 * Bild für Bild, wie beim Filmbau –, und bis das fertig ist, dreht sich an
 * der Hälfte ein Kreisel und sie lässt sich nicht bearbeiten.
 *
 * Immer nur EINE Mitnahme zur Zeit: Jede liest Bilder aus dem Video und
 * startet womöglich ein Modell, und zwei davon nebeneinander verdoppelten
 * den Speicher, ohne schneller fertig zu sein.
 */
export interface SchnittZustand {
  readonly abschnitte: readonly Abschnitt[];
  readonly aktiv: number;
  /** Abschnitte, deren Masken gerade mitgenommen werden oder noch warten. */
  readonly beschaeftigt: ReadonlySet<string>;
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
  /**
   * Das Stellbild versetzen. Hängen Masken am Dokument, werden sie
   * mitgenommen – das ist dann keine Kleinigkeit, siehe oben.
   */
  standSetzen(id: string, ms: number): void;
  /** Alle Bearbeitungen weg – nach einem Wechsel der Rechengrösse. */
  alleVerwerfen(): void;
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
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const liste = useRef(abschnitte);
  liste.current = abschnitte;

  const setAktiv = useCallback((nummer: number) => {
    setAktivRoh(Math.max(0, Math.min(nummer, liste.current.length - 1)));
  }, []);

  const anfangen = useCallback(
    (bisMs: number) => {
      const stueck = { vonMs: 0, bisMs };
      setAbschnitte([
        {
          ...stueck,
          id: abschnittKennung(),
          doc: null,
          standMs: standImRaster(stueck, 0, schrittMs),
        },
      ]);
      setAktivRoh(0);
    },
    [schrittMs],
  );

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
  }, []);

  /* ---------- Die Mitnahme im Hintergrund ---------- */

  const laufSteuer = useRef<AbortController | null>(null);
  /** Wofür die laufende Mitnahme rechnet – siehe den Abbruch weiter unten. */
  const laufZiel = useRef<{ doc: BildDoc; nachMs: number } | null>(null);
  useEffect(() => () => laufSteuer.current?.abort(), []);

  useEffect(() => {
    if (laeuft) return;
    const offen = abschnitte.find(mussVerlegen);
    if (!offen || offen.teileMs === undefined || !offen.doc) return;
    const id = offen.id;
    const doc = offen.doc;
    const vonMs = offen.teileMs;
    const nachMs = offen.standMs;
    const steuer = new AbortController();
    laufSteuer.current = steuer;
    laufZiel.current = { doc, nachMs };
    setLaeuft(id);
    void (async () => {
      try {
        const { teileVerlegen } = await import('./verlegen.js');
        const neu = await teileVerlegen(datei, doc, {
          vonMs,
          nachMs,
          kante,
          schrittMs,
          abbruch: steuer.signal,
        });
        setAbschnitte((alt) =>
          alt.map((abschnitt) => {
            // Inzwischen anders bearbeitet? Dann gilt das Neue, und die
            // gerechnete Fassung ist hinfällig.
            if (abschnitt.id !== id || abschnitt.doc !== doc) return abschnitt;
            if (abschnitt.standMs === nachMs) {
              const { teileMs: _weg, ...ohne } = abschnitt;
              return { ...ohne, doc: neu };
            }
            // Das Stellbild ist währenddessen weitergewandert: Die Masken
            // stehen jetzt bei `nachMs`, und von dort geht es weiter.
            return { ...abschnitt, doc: neu, teileMs: nachMs };
          }),
        );
      } catch (ausfall) {
        if (!(ausfall instanceof AbbruchError)) {
          toast(errorMessage(ausfall, 'Die Masken liessen sich nicht mitnehmen'), 'error');
          // Nicht noch einmal versuchen: Die Masken bleiben, wie sie sind,
          // und gelten beim Filmbau am Stellbild.
          setAbschnitte((alt) =>
            alt.map((abschnitt) => {
              if (abschnitt.id !== id) return abschnitt;
              const { teileMs: _weg, ...ohne } = abschnitt;
              return ohne;
            }),
          );
        }
      } finally {
        if (laufSteuer.current === steuer) laufSteuer.current = null;
        setLaeuft(null);
      }
    })();
    return undefined;
  }, [abschnitte, datei, kante, laeuft, schrittMs]);

  /*
   * Eine Mitnahme, deren Abschnitt verschwunden ist oder deren Ziel sich
   * verschoben hat, braucht niemand mehr.
   *
   * Ohne Abbruch läse sie weiter Bilder und rechnete am alten Ziel ein
   * Modell – und danach käme eine zweite vom alten zum neuen Ziel. Nach dem
   * Abbruch beginnt eine einzige neu: `teileMs` steht noch auf dem Bild, zu
   * dem die Masken gehören, und `standMs` auf dem neuen Ziel. Ein anderes
   * Dokument (neu eingestellt oder verworfen) macht sie ebenso hinfällig.
   */
  useEffect(() => {
    if (!laeuft) return;
    const ziel = abschnitte.find((abschnitt) => abschnitt.id === laeuft);
    const lauf = laufZiel.current;
    if (!ziel || !lauf || ziel.standMs !== lauf.nachMs || ziel.doc !== lauf.doc) {
      laufSteuer.current?.abort();
    }
  }, [abschnitte, laeuft]);

  const beschaeftigt = new Set(abschnitte.filter(mussVerlegen).map((abschnitt) => abschnitt.id));
  if (laeuft) beschaeftigt.add(laeuft);

  return {
    abschnitte,
    aktiv: Math.min(aktiv, Math.max(0, abschnitte.length - 1)),
    beschaeftigt,
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
  };
}

/** Ist irgendwo noch etwas offen, das den Filmbau verfälschen würde? */
export function nochOffen(abschnitte: readonly Abschnitt[]): boolean {
  return abschnitte.some(mussVerlegen);
}

export { haengtAmBild };
