import { useMemo, useState } from 'react';
import type { CalendarEventDto, CollectionDto } from '@initiative/shared';
import type { Person } from '../../components/PersonenWahl.js';
import { useChat } from '../../state/chat.js';
import { useNamen } from '../../state/leute.js';
import { useMyId } from '../../state/session.js';
import { ShareSheet } from '../files/ShareSheet.js';
import { useSammlungKette } from './useSammlungKette.js';
import { zugriffSatz, zugriffsLage } from './terminSammlung.js';

interface Props {
  event: CalendarEventDto;
  sammlung: CollectionDto;
  collections: CollectionDto[];
}

/**
 * „Zugriff der Eingeladenen“ – wer kommt in die verknüpfte Sammlung hinein?
 *
 * Verknüpfen vergibt keine Rechte, und das ist Absicht: Eine bestehende,
 * vielleicht private Sammlung soll nicht still für alle Eingeladenen aufgehen.
 * Dann darf aber der Termin nicht so tun, als sei sie für alle da – vorher
 * sah ein Eingeladener einen Knopf, der in ein Fehlerband führte. Hier steht,
 * wer nicht hineinkommt, und das Nachholen ist ein Tipp entfernt.
 *
 * Es ist auch die Reparatur für Freigaben, die beim Anlegen nicht geklappt
 * haben, und für Eingeladene, die erst später dazukamen.
 */
export function SammlungZugriff({ event, sammlung, collections }: Props) {
  const myId = useMyId();
  const chats = useChat((state) => state.conversations);
  const [neu, setNeu] = useState(0);
  const [teilen, setTeilen] = useState(false);
  const kette = useSammlungKette(collections, sammlung.id, neu);

  const eingeladene = useMemo(
    () =>
      event.attendees.map((teilnehmer) => teilnehmer.userId).filter((userId) => userId !== myId),
    [event.attendees, myId],
  );
  const namen = useNamen([...eingeladene, sammlung.createdBy], myId);

  const lage = useMemo(
    () => (kette ? zugriffsLage({ personen: eingeladene, ich: myId, kette, chats }) : null),
    [kette, eingeladene, myId, chats],
  );

  // Ohne Eingeladene gibt es nichts zu klären.
  if (eingeladene.length === 0) return null;

  const darfVergeben = sammlung.myLevel === 'own';
  const fehlend = lage?.fehlend ?? [];
  const personen: Person[] = eingeladene.map((id) => ({ id, displayName: namen(id) }));

  return (
    <div className="stack" data-testid="sammlung-zugriff">
      <p className="cal-hint" role="status">
        {lage
          ? zugriffSatz(eingeladene.length, fehlend.map(namen))
          : 'Zugriff der Eingeladenen wird geprüft …'}
      </p>

      {lage && fehlend.length > 0 && (
        <>
          {darfVergeben ? (
            <button type="button" className="btn btn-sm" onClick={() => setTeilen(true)}>
              Freigeben …
            </button>
          ) : (
            <p className="cal-hint">
              Freigeben kann nur, wem die Sammlung gehört
              {sammlung.createdBy ? `: ${namen(sammlung.createdBy)}` : ''}.
            </p>
          )}
          <p className="cal-hint">
            Wer später eingeladen wird, bekommt den Zugriff nicht von allein.
          </p>
        </>
      )}

      {darfVergeben && (
        <ShareSheet
          open={teilen}
          onClose={() => {
            setTeilen(false);
            // Was dort vergeben oder zurückgenommen wurde, ändert die Rechnung.
            setNeu((n) => n + 1);
          }}
          collection={sammlung}
          personen={personen}
          vorgewaehlt={fehlend}
        />
      )}
    </div>
  );
}
