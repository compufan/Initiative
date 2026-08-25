import { useEffect, useState } from 'react';
import { LIMITS, NOTE_SCOPES, type EventNoteDto, type NoteScope } from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

interface EventNotesProps {
  eventId: string;
  /** Wer zum Termin gehört – für „nur diese Personen dürfen ändern“. */
  people: { id: string; displayName: string }[];
}

const SCOPE_TEXT: Record<NoteScope, string> = {
  author: 'Nur ich',
  members: 'Alle Eingeladenen',
  listed: 'Nur ausgewählte Personen',
};

/**
 * Notizen am Termin.
 *
 * Jede Notiz bestimmt selbst, wer sie ändern darf. Das ist der Unterschied
 * zwischen der Einkaufsliste, an der alle mitschreiben, und der Ansprache,
 * an der niemand herumbessert.
 */
export function EventNotes({ eventId, people }: EventNotesProps) {
  const [notes, setNotes] = useState<EventNoteDto[]>([]);
  const [laedt, setLaedt] = useState(true);
  const [neu, setNeu] = useState(false);

  useEffect(() => {
    let abgebrochen = false;
    setLaedt(true);
    void api.calendar
      .notes(eventId)
      .then((ergebnis) => {
        if (!abgebrochen) setNotes(ergebnis.items);
      })
      .catch((error: unknown) => {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Notizen nicht ladbar');
      })
      .finally(() => {
        if (!abgebrochen) setLaedt(false);
      });
    return () => {
      abgebrochen = true;
    };
  }, [eventId]);

  return (
    <section className="card stack" aria-labelledby="cal-notes-title">
      <div className="row row-between">
        <h2 id="cal-notes-title" className="cal-block-title">
          Notizen
        </h2>
        {!neu && (
          <button type="button" className="btn btn-sm" onClick={() => setNeu(true)}>
            Notiz hinzufügen
          </button>
        )}
      </div>

      {neu && (
        <NoteEditor
          eventId={eventId}
          people={people}
          onCancel={() => setNeu(false)}
          onSaved={(note) => {
            setNotes((liste) => [...liste, note]);
            setNeu(false);
          }}
        />
      )}

      {laedt ? (
        <Spinner label="Notizen werden geladen …" />
      ) : notes.length === 0 && !neu ? (
        <p className="cal-hint">
          Noch keine Notizen. Bei jeder legst du fest, wer sie ändern darf – eine Einkaufsliste
          für alle, eine Erinnerung nur für dich.
        </p>
      ) : (
        notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            eventId={eventId}
            people={people}
            onChanged={(neue) =>
              setNotes((liste) => liste.map((eintrag) => (eintrag.id === neue.id ? neue : eintrag)))
            }
            onRemoved={() =>
              setNotes((liste) => liste.filter((eintrag) => eintrag.id !== note.id))
            }
          />
        ))
      )}
    </section>
  );
}

function NoteCard({
  note,
  eventId,
  people,
  onChanged,
  onRemoved,
}: {
  note: EventNoteDto;
  eventId: string;
  people: EventNotesProps['people'];
  onChanged: (note: EventNoteDto) => void;
  onRemoved: () => void;
}) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [busy, setBusy] = useState(false);

  if (bearbeiten) {
    return (
      <NoteEditor
        eventId={eventId}
        people={people}
        note={note}
        onCancel={() => setBearbeiten(false)}
        onSaved={(neue) => {
          onChanged(neue);
          setBearbeiten(false);
        }}
      />
    );
  }

  async function loeschen() {
    setBusy(true);
    try {
      await api.calendar.removeNote(eventId, note.id);
      onRemoved();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
      setBusy(false);
    }
  }

  return (
    <article className="cal-note">
      <div className="row row-between">
        <strong className="truncate">{note.title ?? 'Notiz'}</strong>
        <span className="cal-tag" title="Wer diese Notiz ändern darf">
          {SCOPE_TEXT[note.editScope]}
        </span>
      </div>
      <p className="cal-note-body">{note.body}</p>
      {note.canEdit && (
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setBearbeiten(true)}>
            Bearbeiten
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => void loeschen()}
          >
            Löschen
          </button>
        </div>
      )}
    </article>
  );
}

function NoteEditor({
  eventId,
  people,
  note,
  onCancel,
  onSaved,
}: {
  eventId: string;
  people: EventNotesProps['people'];
  note?: EventNoteDto;
  onCancel: () => void;
  onSaved: (note: EventNoteDto) => void;
}) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [scope, setScope] = useState<NoteScope>(note?.editScope ?? 'author');
  const [editorIds, setEditorIds] = useState<string[]>(note?.editorIds ?? []);
  const [busy, setBusy] = useState(false);

  // Wer ändern darf, bestimmt der Verfasser. Bei einer fremden Notiz, die man
  // ändern darf, bleibt die Wahl deshalb gesperrt – der Server lehnt sie
  // ohnehin ab, und ein Feld, das nichts bewirkt, ist schlimmer als keines.
  const darfScopeAendern = !note || note.canEdit === true;

  async function speichern() {
    setBusy(true);
    try {
      const daten = {
        title: title.trim() || undefined,
        body,
        editScope: scope,
        editorIds: scope === 'listed' ? editorIds : [],
      };
      const ergebnis = note
        ? await api.calendar.updateNote(eventId, note.id, daten)
        : await api.calendar.addNote(eventId, daten);
      onSaved(ergebnis);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cal-note cal-note-edit stack">
      <div className="field">
        <label htmlFor={`note-title-${note?.id ?? 'neu'}`}>Überschrift (freiwillig)</label>
        <input
          id={`note-title-${note?.id ?? 'neu'}`}
          className="input"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`note-body-${note?.id ?? 'neu'}`}>Text</label>
        <textarea
          id={`note-body-${note?.id ?? 'neu'}`}
          className="textarea"
          rows={4}
          value={body}
          maxLength={LIMITS.eventDescriptionMax}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      <fieldset className="field" disabled={!darfScopeAendern}>
        <legend>Ändern darf</legend>
        {NOTE_SCOPES.map((wert) => (
          <label key={wert} className="cal-check">
            <input
              type="radio"
              name={`scope-${note?.id ?? 'neu'}`}
              checked={scope === wert}
              onChange={() => setScope(wert)}
            />
            <span>{SCOPE_TEXT[wert]}</span>
          </label>
        ))}
      </fieldset>

      {scope === 'listed' && (
        <fieldset className="field">
          <legend>Diese Personen</legend>
          {people.length === 0 ? (
            <p className="cal-hint">Zu diesem Termin ist sonst niemand eingeladen.</p>
          ) : (
            people.map((person) => (
              <label key={person.id} className="cal-check">
                <input
                  type="checkbox"
                  checked={editorIds.includes(person.id)}
                  onChange={(event) =>
                    setEditorIds((liste) =>
                      event.target.checked
                        ? [...liste, person.id]
                        : liste.filter((id) => id !== person.id),
                    )
                  }
                />
                <span className="truncate">{person.displayName}</span>
              </label>
            ))
          )}
        </fieldset>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => void speichern()}
        >
          {busy ? 'Speichert …' : 'Speichern'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
