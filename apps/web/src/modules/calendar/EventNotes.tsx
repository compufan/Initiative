import { useEffect, useState } from 'react';
import {
  CHECK_SCOPES,
  LIMITS,
  NOTE_SCOPES,
  type CheckScope,
  type EventNoteDto,
  type NoteScope,
} from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { PersonenWahl } from '../../components/PersonenWahl.js';
import { NoteListe } from './NoteListe.js';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
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
      {note.body.trim().length > 0 && <p className="cal-note-body">{note.body}</p>}

      {/* Die Liste. Steht sie leer und darf niemand ergaenzen, zeigt sie
          nichts – eine Notiz ohne Liste soll aussehen wie vorher. */}
      <NoteListe
        eventId={eventId}
        note={note}
        onChanged={onChanged}
        eingeladene={people.length}
        name={(id) => people.find((person) => person.id === id)?.displayName ?? 'Unbekannt'}
      />

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
  const myId = useMyId();
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [scope, setScope] = useState<NoteScope>(note?.editScope ?? 'author');
  const [editorIds, setEditorIds] = useState<string[]>(note?.editorIds ?? []);
  // Drei Rechte statt einem. Bei einer Liste fallen sie auseinander: An einer
  // Packliste duerfen alle abhaken, aber nur der Verfasser Punkte ergaenzen –
  // sonst steht am Abreisetag eine Liste da, die niemand mehr ueberblickt.
  const [addScope, setAddScope] = useState<NoteScope>(note?.addScope ?? 'author');
  const [checkScope, setCheckScope] = useState<CheckScope>(note?.checkScope ?? 'members');
  const [busy, setBusy] = useState(false);

  /*
   * Wer ändern darf, bestimmt der VERFASSER – nicht jeder, der ändern darf.
   * Sonst könnte sich jemand mit Schreibrecht zum alleinigen Bearbeiter
   * machen, und der Server lehnt es folgerichtig ab.
   *
   * Genau daran hing der schwerste Fehler in den Terminen: Hier stand
   * `note.canEdit`, also „darf ändern“ statt „hat verfasst“. Damit schickte
   * die App bei JEDEM Speichern die Rechte mit – und der Server wies jeden
   * ausser dem Verfasser ab. Die Packliste, an der alle mitschreiben sollten,
   * liess sich von niemandem sonst speichern. Die Einstellung war da, die
   * Absicht war da, und trotzdem war das Ganze funktionslos.
   */
  const binVerfasser = !note || note.authorId === myId;

  async function speichern() {
    setBusy(true);
    try {
      const daten: {
        body: string;
        title?: string;
        editScope?: NoteScope;
        editorIds?: string[];
        addScope?: NoteScope;
        checkScope?: CheckScope;
      } = {
        title: title.trim() || undefined,
        body,
      };
      // Die Rechte nur mitschicken, wenn ich sie auch bestimmen darf. Ein
      // unveraendert mitgesendeter Wert ist fuer den Server nicht von einer
      // Aenderung zu unterscheiden.
      if (binVerfasser) {
        daten.editScope = scope;
        daten.editorIds = scope === 'listed' ? editorIds : [];
        daten.addScope = addScope;
        daten.checkScope = checkScope;
      }
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

      <fieldset className="field" disabled={!binVerfasser}>
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
        <fieldset className="field" disabled={!binVerfasser}>
          <legend>Diese Personen</legend>
          <PersonenWahl
            label="Wer diese Notiz ändern darf"
            vorschlaege={people}
            gewaehlt={editorIds}
            onChange={setEditorIds}
          />
        </fieldset>
      )}

      {/* Die beiden Rechte, die nur eine Liste braucht. Bei einer reinen
          Textnotiz sind sie ohne Wirkung und stehen deshalb hinter einer
          Klappe – sichtbar für den, der sie sucht, im Weg für niemanden. */}
      <details className="field" open={(note?.items.length ?? 0) > 0}>
        <summary>Für eine Liste: wer darf was?</summary>

        <fieldset className="field" disabled={!binVerfasser}>
          <legend>Punkte hinzufügen darf</legend>
          {NOTE_SCOPES.map((wert) => (
            <label key={wert} className="cal-check">
              <input
                type="radio"
                name={`add-${note?.id ?? 'neu'}`}
                checked={addScope === wert}
                onChange={() => setAddScope(wert)}
              />
              <span>{SCOPE_TEXT[wert]}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="field" disabled={!binVerfasser}>
          <legend>Abhaken darf</legend>
          {CHECK_SCOPES.map((wert) => (
            <label key={wert} className="cal-check">
              <input
                type="radio"
                name={`check-${note?.id ?? 'neu'}`}
                checked={checkScope === wert}
                onChange={() => setCheckScope(wert)}
              />
              <span>{wert === 'nobody' ? 'Niemand (nur zum Nachlesen)' : SCOPE_TEXT[wert]}</span>
            </label>
          ))}
        </fieldset>
      </details>

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
