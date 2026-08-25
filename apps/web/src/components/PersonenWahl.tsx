import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Mehr braucht die Wahl nicht zu wissen. Absichtlich nicht `UserDto`: Die
 * Aufrufer haben oft nur Kennung und Namen zur Hand, und mehr ist hier auch
 * nicht zu zeigen.
 */
export interface Person {
  id: string;
  displayName: string;
}

/**
 * Personen auswählen – überall dort, wo Zugriffe geregelt werden.
 *
 * Zwei Dinge, die in den bisherigen Listen fehlten und beide wehtun:
 *
 * **„Alle auswählen“.** Bei acht Leuten ist es acht Mal Tippen, um zu sagen,
 * was in einem Wort gesagt wäre – und wer einen vergisst, merkt es erst, wenn
 * jemand fragt, warum er die Notiz nicht ändern darf.
 *
 * **Jemand von ausserhalb des Chats.** Die Vorschläge kommen aus dem Chat,
 * weil das der häufige Fall ist. Er ist aber nicht der einzige: Zur
 * Hüttenplanung gehört manchmal jemand, der in der Gruppe gar nicht drin ist.
 * Wer sucht, findet jeden – und die Auswahl bleibt bestehen, auch wenn das
 * Suchfeld wieder leer ist.
 *
 * Ausgewählte stehen immer oben und immer sichtbar. Nichts ist ärgerlicher als
 * eine Auswahl, die sich beim Weitertippen versteckt.
 */

interface Props {
  /** Wer zur Wahl steht, ohne dass man suchen muss – meist die Chatmitglieder. */
  vorschlaege: Person[];
  gewaehlt: string[];
  onChange: (ids: string[]) => void;
  /**
   * Kennungen, die auf jeden Fall dabei sind und sich nicht abwählen lassen –
   * etwa man selbst als Verfasser.
   *
   * Sie werden **angehakt und gesperrt** dargestellt. Das war einmal anders:
   * Haken und Sperre waren zwei unabhängige Dinge, und wer `fest` gesetzt hat,
   * ohne die Kennung zusätzlich in `gewaehlt` zu führen, bekam ein
   * ausgegrautes *leeres* Kästchen – zu lesen als „ausdrücklich nicht dabei“,
   * also das Gegenteil des Gemeinten.
   */
  fest?: string[];
  /**
   * Kennungen, die gar nicht erst zur Wahl stehen – auch nicht über die Suche.
   *
   * Der Unterschied zu `fest` ist wichtig: `fest` heisst „dabei und nicht
   * abwählbar“, `ausschluss` heisst „kommt hier nicht vor“. Wer jemanden zu
   * einem Chat hinzufügt, in dem er schon ist, löst sonst eine Systemnachricht
   * „X wurde hinzugefügt“ für jemanden aus, der längst dabei ist.
   */
  ausschluss?: string[];
  /** Überschrift der Gruppe, für Vorlesehilfen. */
  label: string;
  /** Ob über die Vorschläge hinaus gesucht werden darf. */
  suchbar?: boolean;
  /** Beschriftung des Suchfelds, wenn „Jemanden suchen“ zu unbestimmt ist. */
  suchePlatzhalter?: string;
  /** Zusatz je Person, etwa der Anteil in Cent. */
  zusatz?: (id: string) => React.ReactNode;
}

export function PersonenWahl({
  vorschlaege,
  gewaehlt,
  onChange,
  fest = [],
  ausschluss = [],
  label,
  suchbar = true,
  suchePlatzhalter = 'Jemanden suchen (auch ausserhalb des Chats) …',
  zusatz,
}: Props) {
  const [suche, setSuche] = useState('');
  const [treffer, setTreffer] = useState<Person[]>([]);
  const [sucht, setSucht] = useState(false);

  // Suche mit Verzögerung: Jeder Tastendruck eine Anfrage wäre auf einem
  // Handy im Zug spürbar – und für den Server unnötig.
  useEffect(() => {
    const begriff = suche.trim();
    if (!suchbar || begriff.length < 2) {
      setTreffer([]);
      return undefined;
    }
    setSucht(true);
    const timer = window.setTimeout(() => {
      void api.users
        .search(begriff)
        .then((ergebnis) => setTreffer(ergebnis.items))
        .catch(() => setTreffer([]))
        .finally(() => setSucht(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      setSucht(false);
    };
  }, [suche, suchbar]);

  // Alles, was gerade zur Wahl steht: Vorschläge, Suchtreffer – und immer die
  // bereits Gewählten, damit keiner beim Tippen verschwindet.
  const [gemerkt, setGemerkt] = useState<Record<string, Person>>({});
  useEffect(() => {
    setGemerkt((vorher) => {
      const naechster = { ...vorher };
      for (const person of [...vorschlaege, ...treffer]) naechster[person.id] = person;
      return naechster;
    });
  }, [vorschlaege, treffer]);

  const liste = useMemo(() => {
    const nach: Person[] = [];
    const gesehen = new Set<string>();
    const draussen = new Set(ausschluss);
    const anhaengen = (person: Person | undefined) => {
      if (!person || gesehen.has(person.id) || draussen.has(person.id)) return;
      gesehen.add(person.id);
      nach.push(person);
    };
    for (const id of gewaehlt) anhaengen(gemerkt[id]);
    for (const person of vorschlaege) anhaengen(person);
    // Auch Suchtreffer gehen durch denselben Filter – sonst fördert die Suche
    // genau die zutage, die hier nichts zu suchen haben.
    for (const person of treffer) anhaengen(person);
    return nach;
  }, [gewaehlt, vorschlaege, treffer, gemerkt, ausschluss]);

  const waehlbar = liste.filter((person) => !fest.includes(person.id));
  const alleGewaehlt =
    waehlbar.length > 0 && waehlbar.every((person) => gewaehlt.includes(person.id));
  // Die Gesperrten zählen mit, weil sie sichtbar angehakt sind – sonst
  // widerspricht die Zahl dem, was man sieht.
  const anzahl = new Set([...gewaehlt, ...fest.filter((id) => liste.some((p) => p.id === id))])
    .size;

  function umschalten(id: string) {
    if (fest.includes(id)) return;
    onChange(gewaehlt.includes(id) ? gewaehlt.filter((wert) => wert !== id) : [...gewaehlt, id]);
  }

  return (
    <div className="pw" role="group" aria-label={label}>
      <div className="pw-kopf">
        <button
          type="button"
          className="btn btn-sm"
          disabled={waehlbar.length === 0}
          onClick={() =>
            onChange(
              alleGewaehlt
                ? gewaehlt.filter((id) => fest.includes(id))
                : [...new Set([...gewaehlt, ...waehlbar.map((person) => person.id)])],
            )
          }
        >
          {alleGewaehlt ? 'Auswahl leeren' : 'Alle auswählen'}
        </button>
        <span className="pw-zahl">
          {anzahl} {anzahl === 1 ? 'Person' : 'Personen'}
        </span>
      </div>

      {suchbar && (
        <input
          type="search"
          className="input pw-suche"
          value={suche}
          placeholder={suchePlatzhalter}
          aria-label={suchePlatzhalter}
          onChange={(event) => setSuche(event.target.value)}
        />
      )}

      {sucht && <p className="pw-hinweis">Wird gesucht …</p>}
      {suchbar && suche.trim().length >= 2 && !sucht && treffer.length === 0 && (
        <p className="pw-hinweis">Niemand gefunden.</p>
      )}

      <div className="pw-liste">
        {liste.map((person) => {
          const gesperrt = fest.includes(person.id);
          // Gesperrt heisst „auf jeden Fall dabei“ – also auch angehakt, ganz
          // gleich, ob der Aufrufer die Kennung in `gewaehlt` führt oder der
          // Server sie ohnehin hinzufügt.
          const an = gesperrt || gewaehlt.includes(person.id);
          return (
            <label key={person.id} className={gesperrt ? 'pw-zeile is-fest' : 'pw-zeile'}>
              <input
                type="checkbox"
                checked={an}
                disabled={gesperrt}
                onChange={() => umschalten(person.id)}
              />
              <span className="truncate">{person.displayName}</span>
              {zusatz?.(person.id)}
            </label>
          );
        })}
      </div>
    </div>
  );
}
