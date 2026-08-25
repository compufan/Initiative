import { useState } from 'react';
import { LIMITS, MEMBER_LEVELS, type CollectionDto, type MemberLevel } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { useFiles } from './state.js';

interface CollectionSheetProps {
  open: boolean;
  onClose: () => void;
  /** Zum Bearbeiten – sonst wird eine neue Sammlung angelegt. */
  collection?: CollectionDto | null;
  /** In welchem Ordner die neue Sammlung liegen soll. */
  parentId?: string | null;
  /** Aus welchem Chat sie stammt (nur beim Anlegen). */
  conversationId?: string | null;
  onSaved?: (collection: CollectionDto) => void;
}

const STUFEN_TEXT: Record<MemberLevel, string> = {
  none: 'gar nichts – nur wer ausdrücklich ein Recht bekommt',
  view: 'ansehen und herunterladen',
  edit: 'ansehen und Dateien hinzufügen',
};

export function CollectionSheet({
  open,
  onClose,
  collection,
  parentId,
  conversationId,
  onSaved,
}: CollectionSheetProps) {
  const [name, setName] = useState(collection?.name ?? '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const [memberLevel, setMemberLevel] = useState<MemberLevel>(collection?.memberLevel ?? 'edit');
  const [busy, setBusy] = useState(false);

  const bearbeiten = Boolean(collection);
  const chat = collection?.conversationId ?? conversationId ?? null;
  // Die Stufe für alle im Chat darf nur ändern, wem die Sammlung gehört –
  // der Server sagt dasselbe noch einmal, das hier ist nur die Anzeige.
  const darfStufeAendern = !bearbeiten || collection?.myLevel === 'own';

  async function speichern() {
    const sauber = name.trim();
    if (!sauber) {
      toast('Die Sammlung braucht einen Namen.');
      return;
    }
    setBusy(true);
    try {
      const ergebnis = collection
        ? await api.collections.update(collection.id, {
            name: sauber,
            description: description.trim() || null,
            ...(darfStufeAendern ? { memberLevel } : {}),
          })
        : await api.collections.create({
            name: sauber,
            description: description.trim() || undefined,
            parentId: parentId ?? undefined,
            conversationId: conversationId ?? undefined,
            memberLevel,
          });
      useFiles.getState().upsert(ergebnis);
      onSaved?.(ergebnis);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={bearbeiten ? 'Sammlung bearbeiten' : 'Neue Sammlung'}
      actions={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void speichern()}>
          {busy ? 'Speichert …' : 'Speichern'}
        </button>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="col-name">Name</label>
          <input
            id="col-name"
            className="input"
            type="text"
            value={name}
            maxLength={LIMITS.collectionNameMax}
            placeholder="Urlaubsbilder"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="col-desc">Beschreibung (freiwillig)</label>
          <textarea
            id="col-desc"
            className="textarea"
            rows={2}
            value={description}
            maxLength={LIMITS.collectionDescriptionMax}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {chat && (
          <fieldset className="field">
            <legend>Wer im Chat ist, darf …</legend>
            {MEMBER_LEVELS.map((stufe) => (
              <label key={stufe} className="fil-radio">
                <input
                  type="radio"
                  name="memberLevel"
                  checked={memberLevel === stufe}
                  disabled={!darfStufeAendern}
                  onChange={() => setMemberLevel(stufe)}
                />
                <span>{STUFEN_TEXT[stufe]}</span>
              </label>
            ))}
            {!darfStufeAendern && (
              <p className="fil-hint">Das darf nur ändern, wem die Sammlung gehört.</p>
            )}
          </fieldset>
        )}

        {!chat && !bearbeiten && (
          <p className="fil-hint">
            Diese Sammlung gehört zunächst nur dir. Über „Teilen“ kannst du einzelne Personen oder
            einen ganzen Chat dazunehmen.
          </p>
        )}
      </div>
    </Sheet>
  );
}
