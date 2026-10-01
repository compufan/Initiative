import { useId, useMemo, useState } from 'react';
import { LIMITS, type CollectionDto } from '@initiative/shared';
import { ordnerZeilen } from './ordner.js';

interface Props {
  collections: CollectionDto[];
  /** Der gewählte Ordner – `null` ist die oberste Ebene. */
  wert: string | null;
  onChange: (id: string | null) => void;
  /** Beschriftung der Gruppe für Vorlesehilfen. */
  label: string;
  nurAendern?: boolean;
  maxTiefe?: number;
  obersteEbeneText?: string;
  /** Ordner, die der Server schon als zu tief abgelehnt hat. */
  gesperrt?: ReadonlySet<string>;
}

/** Ab so vielen Zeilen lohnt ein Suchfeld – darunter wäre es nur Rauschen. */
const FILTER_AB = 10;

/**
 * Einen Ordner wählen – als eingerückte Liste aus Radioknöpfen.
 *
 * Bewusst keine aufklappbare Baumansicht: Auf einem Telefon mit vierzig
 * Ordnern ist eine durchgehende Liste mit Filter schneller als Aufklappen,
 * spart einen Tipp je Ebene und braucht keine Zustandsverwaltung. Native
 * Radios, weil Tastatur, Vorlesehilfe und Tests sie ohne Zutun kennen – ein
 * selbstgebauter ARIA-Baum wäre mehr Code für weniger Verlass.
 *
 * Wo man nichts anlegen darf oder die Tiefe erschöpft ist, steht die Zeile
 * grau und mit Grund da, statt zu fehlen: Wer „Urlaube › 2025“ sucht und sie
 * nicht findet, fragt sich sonst, ob sie weg ist.
 */
export function OrdnerWahl({
  collections,
  wert,
  onChange,
  label,
  nurAendern = true,
  maxTiefe,
  obersteEbeneText = 'Oberste Ebene',
  gesperrt,
}: Props) {
  const name = useId();
  const [filter, setFilter] = useState('');

  const optionen = useMemo(
    () => ({ nurAendern, maxTiefe, zuTiefIds: gesperrt }),
    [nurAendern, maxTiefe, gesperrt],
  );
  const alle = useMemo(() => ordnerZeilen(collections, optionen), [collections, optionen]);
  const zeilen = useMemo(
    () => (filter.trim() ? ordnerZeilen(collections, { ...optionen, filter }) : alle),
    [collections, optionen, alle, filter],
  );
  const zuTief = zeilen.some((zeile) => zeile.grund === 'zuTief');

  return (
    <div className="fil-baum" role="radiogroup" aria-label={label}>
      {alle.length >= FILTER_AB && (
        <input
          type="search"
          className="input"
          value={filter}
          placeholder="Ordner suchen …"
          aria-label="Ordner suchen"
          onChange={(event) => setFilter(event.target.value)}
        />
      )}

      <div className="fil-baum-liste">
        {/* Die oberste Ebene gibt es immer und gilt, solange nichts anderes gewählt ist. */}
        <label className="fil-baum-zeile" style={{ '--tiefe': 0 } as React.CSSProperties}>
          <input type="radio" name={name} checked={wert === null} onChange={() => onChange(null)} />
          <span className="truncate">{obersteEbeneText}</span>
        </label>

        {zeilen.map(({ collection, depth, wahlbar, grund, gedaempft }) => (
          <label
            key={collection.id}
            className={['fil-baum-zeile', wahlbar ? '' : 'is-grau', gedaempft ? 'is-gedaempft' : '']
              .filter(Boolean)
              .join(' ')}
            style={{ '--tiefe': depth + 1 } as React.CSSProperties}
          >
            <input
              type="radio"
              name={name}
              checked={wert === collection.id}
              disabled={!wahlbar}
              onChange={() => onChange(collection.id)}
            />
            <span className="truncate">{collection.name}</span>
            {grund === 'nurAnsehen' && <span className="fil-badge">nur ansehen</span>}
            {grund === 'zuTief' && <span className="fil-badge">zu tief</span>}
          </label>
        ))}
      </div>

      {filter.trim() && zeilen.length === 0 && <p className="fil-hint">Kein Ordner gefunden.</p>}
      {zuTief && (
        <p className="fil-hint">
          Mehr als {LIMITS.collectionDepthMax} Ebenen sind nicht vorgesehen. Wähle einen Ordner
          weiter oben.
        </p>
      )}
    </div>
  );
}
