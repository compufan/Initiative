import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
  const [ladeFehler, setLadeFehler] = useState(false);
  const [erneut, setErneut] = useState(0);

  /*
   * Ein Fehlschlag beim Laden wird gezeigt, nicht verschluckt.
   *
   * Hier stand `.catch(() => {})`. Ohne Netz blieb `sammlungen` leer – und
   * damit verlor sogar die BEREITS verknüpfte Sammlung ihren Namen: Der Knopf
   * unten fällt dann auf „Zur Sammlung“ zurück, das Auswahlfeld sieht aus, als
   * gäbe es keine einzige Sammlung. Es sah nach „nichts da“ aus, wo „nicht
   * geladen“ richtig gewesen wäre.
   */
  useEffect(() => {
    let abgebrochen = false;
    setLadeFehler(false);
    void api.collections
      .list()
      .then(({ items }) => {
        if (!abgebrochen) setSammlungen(items);
      })
      .catch(() => {
        if (!abgebrochen) setLadeFehler(true);
      });
    return () => {
      abgebrochen = true;
    };
  }, [erneut]);

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

      {/*
          `Link`, kein rohes `href`: Ein echter Seitenaufruf lädt die ganze
          PWA neu – Zustand fort, Verlauf fort, und auf einem Telefon dauert
          es sichtbar. Jede andere Stelle im Modul macht es längst so.
      */}
      {event.collectionId && (
        <Link
          className="btn btn-block"
          to={`/dateien/${event.collectionId}`}
          data-tipp="Öffnet den Ordner mit allen Dateien und Bildern, die zu diesem Termin gehören"
        >
          📁 {verknuepft?.name ?? 'Zur Sammlung'}
        </Link>
      )}

      {ladeFehler && (
        <p className="cal-hint">
          Die Sammlungen konnten nicht geladen werden.{' '}
          <button type="button" className="btn btn-sm" onClick={() => setErneut((n) => n + 1)}>
            Erneut versuchen
          </button>
        </p>
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
