import { useEffect, useState } from 'react';
import type { CalendarEventDto, ErinnernStandDto } from '@initiative/shared';

import { api } from '../../lib/api.js';
import { useUserLookup } from './helpers.js';

/**
 * Für den Ersteller: wie weit das Erinnern eines Termins ist – wer schon wie
 * oft erinnert wurde und wer gar nicht erinnert werden kann.
 *
 * Lädt neu, wenn sich der Stand des Termins ändert (jede Zusage, jede
 * Erinnerungswelle ruft einen Rundruf hervor), und nie öfter.
 */
export function ErinnernStand({ event }: { event: CalendarEventDto }) {
  const [stand, setStand] = useState<ErinnernStandDto | null>(null);
  const ids = [
    ...(stand?.personen.map((person) => person.userId) ?? []),
    ...(stand?.ohneEinzelchat ?? []),
  ];
  const nutzer = useUserLookup(ids);
  const name = (id: string) => nutzer[id]?.displayName ?? 'Jemand';

  useEffect(() => {
    if (!event.erinnern) {
      setStand(null);
      return undefined;
    }
    let weg = false;
    api.calendar
      .erinnerungen(event.id)
      .then((antwort) => {
        if (!weg) setStand(antwort);
      })
      .catch(() => {
        if (!weg) setStand(null);
      });
    return () => {
      weg = true;
    };
  }, [event.id, event.stand, event.erinnern]);

  if (!event.erinnern || !stand?.aktiv) return null;
  if (stand.personen.length === 0 && stand.ohneEinzelchat.length === 0) {
    return (
      <section className="cal-erinn-stand" aria-label="Erinnerungen">
        <h3>Erinnerungen</h3>
        <p className="cal-hint">Alle haben geantwortet.</p>
      </section>
    );
  }
  return (
    <section className="cal-erinn-stand" aria-label="Erinnerungen">
      <h3>Erinnerungen</h3>
      <ul>
        {stand.personen.map((person) => (
          <li key={person.userId}>
            {name(person.userId)}:{' '}
            {person.gesendet === 0
              ? 'noch keine gesendet'
              : `${person.gesendet}${event.erinnern?.anzahl === null ? '' : ` von ${stand.hoechstens}`} gesendet${
                  person.zuletztAm ? ` · zuletzt ${zeitpunkt(person.zuletztAm)}` : ''
                }`}
          </li>
        ))}
      </ul>
      {stand.ohneEinzelchat.length > 0 && (
        <p className="cal-hint">
          Nicht erinnerbar (kein Einzelchat mit der Einladung):{' '}
          {stand.ohneEinzelchat.map((id, nummer) => (
            <span key={id}>
              {nummer > 0 && ', '}
              {name(id)}
            </span>
          ))}
          . Beim Einladen lässt sich das mit „Einzelchats“ ändern.
        </p>
      )}
    </section>
  );
}

function zeitpunkt(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
