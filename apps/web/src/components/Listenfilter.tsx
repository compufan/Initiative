import { useMemo, useState, type ReactNode } from 'react';

/**
 * Suchen und Filtern – einmal gebaut, für jede Liste der App.
 *
 * Der entscheidende Gedanke: **Die Filterwerte werden nicht aufgezählt,
 * sondern aus den Daten abgeleitet.** Wer eine Facette angibt, sagt nur, wie
 * man aus einem Eintrag seine Werte liest; welche es gibt, ergibt sich jedes
 * Mal neu aus dem, was gerade in der Liste steht.
 *
 * Das ist kein Sparen an Tipparbeit, sondern der Unterschied zwischen einem
 * Filter, der mitwächst, und einem, den man bei jeder neuen Möglichkeit
 * nachziehen muss – und den man garantiert einmal vergisst. Kommt morgen ein
 * Ausgabenzustand dazu oder ein neuer Chat, steht er ohne Zutun zur Wahl.
 *
 * Ein Wert, den kein Eintrag mehr hat, verschwindet ebenso von selbst. Ist er
 * gerade ausgewählt, bleibt er stehen, solange er ausgewählt ist – sonst
 * verschwände unter den Fingern die Erklärung dafür, warum die Liste leer ist.
 */

export interface Facette<T> {
  /** Kennung, nur intern. */
  key: string;
  /** Was in der Leiste steht, etwa „Zustand“. */
  label: string;
  /**
   * Die Werte dieses Eintrags. Mehrere sind erlaubt – eine Ausgabe hat einen
   * Zustand, aber mehrere Beteiligte. Leere Einträge werden verworfen.
   */
  werte: (item: T) => Array<Wert | null | undefined>;
  /**
   * Feste Reihenfolge der Werte. Was hier nicht steht, kommt alphabetisch
   * dahinter. Für Zustände wichtig: „offen“ gehört vor „abgeschlossen“, nicht
   * hinter „bestätigt“.
   */
  reihenfolge?: string[];
}

export interface Wert {
  id: string;
  label: string;
}

interface Optionen<T> {
  /** Woraus die Volltextsuche liest. */
  suchtext: (item: T) => string;
  facetten?: Facette<T>[];
  /** Beschriftung des Suchfelds. */
  suchePlatzhalter?: string;
}

interface Ergebnis<T> {
  gefiltert: T[];
  /** Suchfeld und Filterleiste – irgendwo über der Liste einsetzen. */
  steuerung: ReactNode;
  /** Ob überhaupt gefiltert wird (für einen ehrlichen Leerzustand). */
  aktiv: boolean;
  zuruecksetzen: () => void;
}

export function useListenfilter<T>(items: T[], optionen: Optionen<T>): Ergebnis<T> {
  const { suchtext, facetten = [], suchePlatzhalter = 'Suchen …' } = optionen;
  const [suche, setSuche] = useState('');
  const [gewaehlt, setGewaehlt] = useState<Record<string, string[]>>({});

  // Welche Werte gibt es gerade? Aus den Daten, nicht aus einer Liste im Code.
  const angebot = useMemo(() => {
    const je: Record<string, Map<string, string>> = {};
    for (const facette of facetten) {
      const werte = new Map<string, string>();
      for (const item of items) {
        for (const wert of facette.werte(item)) {
          if (wert && !werte.has(wert.id)) werte.set(wert.id, wert.label);
        }
      }
      // Ausgewähltes bleibt sichtbar, auch wenn es gerade zu nichts passt –
      // sonst verschwindet der Grund, warum die Liste leer ist.
      for (const id of gewaehlt[facette.key] ?? []) {
        if (!werte.has(id)) werte.set(id, id);
      }
      je[facette.key] = werte;
    }
    return je;
  }, [items, facetten, gewaehlt]);

  const gefiltert = useMemo(() => {
    const begriff = suche.trim().toLowerCase();
    return items.filter((item) => {
      if (begriff && !suchtext(item).toLowerCase().includes(begriff)) return false;
      for (const facette of facetten) {
        const auswahl = gewaehlt[facette.key];
        if (!auswahl || auswahl.length === 0) continue;
        // Innerhalb einer Facette gilt ODER, zwischen Facetten UND. Das ist
        // die Erwartung überall sonst auch: „offen ODER gemeldet“, aber
        // „offen UND in diesem Chat“.
        const hat = facette
          .werte(item)
          .some((wert) => wert != null && auswahl.includes(wert.id));
        if (!hat) return false;
      }
      return true;
    });
  }, [items, suche, gewaehlt, facetten, suchtext]);

  const aktiv = suche.trim().length > 0 || Object.values(gewaehlt).some((liste) => liste.length > 0);

  function umschalten(facette: string, id: string) {
    setGewaehlt((vorher) => {
      const liste = vorher[facette] ?? [];
      const neu = liste.includes(id) ? liste.filter((wert) => wert !== id) : [...liste, id];
      return { ...vorher, [facette]: neu };
    });
  }

  const steuerung = (
    <div className="lf">
      <input
        type="search"
        className="input lf-suche"
        value={suche}
        placeholder={suchePlatzhalter}
        aria-label={suchePlatzhalter}
        onChange={(event) => setSuche(event.target.value)}
      />

      {facetten.map((facette) => {
        const werte = sortiert(angebot[facette.key] ?? new Map(), facette.reihenfolge);
        // Eine Facette mit nur einem Wert filtert nichts – sie kostet nur
        // Platz auf einem Handyschirm.
        if (werte.length < 2) return null;
        const auswahl = gewaehlt[facette.key] ?? [];
        return (
          <div key={facette.key} className="lf-zeile">
            <span className="lf-label">{facette.label}</span>
            <div className="lf-chips" role="group" aria-label={facette.label}>
              {werte.map(([id, label]) => {
                const an = auswahl.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={an ? 'lf-chip is-an' : 'lf-chip'}
                    aria-pressed={an}
                    onClick={() => umschalten(facette.key, id)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {aktiv && (
        <button
          type="button"
          className="btn btn-sm lf-reset"
          onClick={() => {
            setSuche('');
            setGewaehlt({});
          }}
        >
          Filter zurücksetzen
        </button>
      )}
    </div>
  );

  return {
    gefiltert,
    steuerung,
    aktiv,
    zuruecksetzen: () => {
      setSuche('');
      setGewaehlt({});
    },
  };
}

function sortiert(werte: Map<string, string>, reihenfolge?: string[]): Array<[string, string]> {
  const eintraege = [...werte.entries()];
  if (!reihenfolge) return eintraege.sort((a, b) => a[1].localeCompare(b[1], 'de'));
  const rang = (id: string) => {
    const index = reihenfolge.indexOf(id);
    return index < 0 ? reihenfolge.length : index;
  };
  return eintraege.sort((a, b) => rang(a[0]) - rang(b[0]) || a[1].localeCompare(b[1], 'de'));
}
