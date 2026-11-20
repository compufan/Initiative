import type { ErwaehnbarePerson } from '@initiative/shared';
import { ALLE_KENNUNG } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';

/**
 * Die Vorschlagsliste über der Eingabezeile, sobald jemand „@“ tippt.
 *
 * Eine Listbox nach ARIA-Muster: Der Fokus bleibt im Textfeld (es trägt
 * `aria-activedescendant`), ↑/↓ wählen, Enter oder Tab übernimmt, Escape
 * schliesst – das alles steuert der Composer. Ein Tipp/Klick übernimmt auch.
 */
export function ErwaehnungsVorschlaege({
  id,
  vorschlaege,
  aktiv,
  onWaehlen,
}: {
  id: string;
  vorschlaege: ErwaehnbarePerson[];
  aktiv: number;
  onWaehlen: (person: ErwaehnbarePerson) => void;
}) {
  if (vorschlaege.length === 0) return null;
  return (
    <ul id={id} className="msg-erwaehnung-liste" role="listbox" aria-label="Erwähnen">
      {vorschlaege.map((person, index) => (
        <li
          key={person.userId}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === aktiv}
          className={`msg-erwaehnung-option${index === aktiv ? ' is-aktiv' : ''}`}
          // Der Fokus bleibt im Textfeld.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onWaehlen(person)}
        >
          {person.userId === ALLE_KENNUNG ? (
            <span className="msg-erwaehnung-alle" aria-hidden="true">
              @
            </span>
          ) : (
            <Avatar name={person.name} id={person.userId} size={28} />
          )}
          <span className="msg-erwaehnung-name">
            {person.userId === ALLE_KENNUNG ? 'alle' : person.name}
            <small>
              {person.userId === ALLE_KENNUNG
                ? 'Alle in der Gruppe benachrichtigen'
                : person.username
                  ? `@${person.username}`
                  : ''}
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}
