import { useEffect, useState } from 'react';
import type { CalendarEventDto, CollectionDto } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

interface Props {
  event: CalendarEventDto;
  canManage: boolean;
  onChanged: (event: CalendarEventDto) => void;
}

/**
 * Die Sammlung zum Termin.
 *
 * Der Server konnte das von Anfang an – die Spalte war da, die Route war da,
 * der Aufruf lag fertig im Client. Nur gab es keine einzige Stelle, an der man
 * ihn ausgelöst hätte. Eine Fähigkeit, die man nicht erreicht, ist keine.
 *
 * Bewusst eine Verknüpfung statt einer Kopie: Die Bilder vom Wochenende liegen
 * in der Sammlung, wo sie hingehören, und der Termin zeigt dorthin. Zweimal
 * dasselbe an zwei Orten wäre zweimal Aufräumen.
 */
export function EventCollection({ event, canManage, onChanged }: Props) {
  const [sammlungen, setSammlungen] = useState<CollectionDto[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let abgebrochen = false;
    void api.collections
      .list()
      .then(({ items }) => {
        if (!abgebrochen) setSammlungen(items);
      })
      .catch(() => {});
    return () => {
      abgebrochen = true;
    };
  }, []);

  const verknuepft = sammlungen.find((eintrag) => eintrag.id === event.collectionId) ?? null;

  async function setzen(collectionId: string | null) {
    setBusy(true);
    try {
      onChanged(await api.calendar.linkCollection(event.id, collectionId));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nicht verknüpft');
    } finally {
      setBusy(false);
    }
  }

  // Ohne Verknüpfung und ohne Recht gibt es nichts zu zeigen – eine leere
  // Karte wäre nur Rauschen.
  if (!canManage && !event.collectionId) return null;

  return (
    <section className="card stack" aria-labelledby="cal-coll-title">
      <h2 id="cal-coll-title" className="cal-block-title">
        Sammlung
      </h2>

      {event.collectionId && (
        <a className="btn btn-block" href={`/dateien/${event.collectionId}`}>
          📁 {verknuepft?.name ?? 'Zur Sammlung'}
        </a>
      )}

      {canManage && (
        <div className="field">
          <label htmlFor="cal-coll-select">Mit einer Sammlung verknüpfen</label>
          <select
            id="cal-coll-select"
            className="select"
            value={event.collectionId ?? ''}
            disabled={busy}
            onChange={(änderung) => void setzen(änderung.target.value || null)}
          >
            <option value="">Keine</option>
            {sammlungen.map((eintrag) => (
              <option key={eintrag.id} value={eintrag.id}>
                {eintrag.name}
              </option>
            ))}
          </select>
          <p className="cal-hint">
            Alles, was in dieser Sammlung liegt, gehört damit sichtbar zum Termin – ohne dass es
            doppelt herumliegt.
          </p>
        </div>
      )}
    </section>
  );
}
