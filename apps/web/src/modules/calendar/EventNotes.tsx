import { useEffect, useState } from 'react';
import {
  CHECK_SCOPES,
  LIMITS,
  NOTE_SCOPES,
  type CheckScope,
  type EventNoteDto,
  type NoteKind,
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
  // Welche Art gerade angelegt wird – oder `null`, wenn nichts offen ist.
  const [neu, setNeu] = useState<NoteKind | null>(null);

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

  // Getrennt anzeigen. Eine Einkaufsliste und eine Ansprache standen bisher
  // als gleich aussehende Karten untereinander.
  const listen = notes.filter((note) => note.kind === 'list');
  const texte = notes.filter((note) => note.kind !== 'list');
  const beides = listen.length > 0 && texte.length > 0;
  const gruppen = [
    { art: 'list' as const, ueberschrift: 'Listen', eintraege: listen },
    { art: 'note' as const, ueberschrift: 'Notizen', eintraege: texte },
  ];

  return (
    <section className="card stack" aria-labelledby="cal-notes-title">
      <div className="row row-between">
        <h2 id="cal-notes-title" className="cal-block-title">
          Notizen und Listen
        </h2>
        {!neu && (
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => setNeu('note')}>
              Notiz
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setNeu('list')}>
              Liste
            </button>
          </div>
        )}
      </div>

      {neu && (
        <NoteEditor
          eventId={eventId}
          people={people}
          kind={neu}
          onCancel={() => setNeu(null)}
          onSaved={(note) => {
            setNotes((liste) => [...liste, note]);
            setNeu(null);
          }}
        />
      )}

      {laedt ? (
        <Spinner label="Notizen werden geladen …" />
      ) : notes.length === 0 && !neu ? (
        <p className="cal-hint">
          Noch nichts da. Eine <b>Notiz</b> ist ein Text – die Adresse, eine Erinnerung. Eine{' '}
          <b>Liste</b> hat Punkte zum Abhaken, und du legst fest, wer ergänzen und wer abhaken
          darf.
        </p>
      ) : (
        <>
          {gruppen.map(({ art, ueberschrift, eintraege }) =>
            eintraege.length === 0 ? null : (
              <div key={art} className="stack">
                {/* Die Überschrift nur, wenn wirklich beides da ist – bei einer
                    einzigen Notiz wäre sie Beiwerk. */}
                {beides && <h3 className="cal-block-title">{ueberschrift}</h3>}
                {eintraege.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    eventId={eventId}
                    people={people}
                    onChanged={(neue) =>
                      setNotes((liste) =>
                        liste.map((eintrag) => (eintrag.id === neue.id ? neue : eintrag)),
                      )
                    }
                    onRemoved={() =>
                      setNotes((liste) => liste.filter((eintrag) => eintrag.id !== note.id))
                    }
                  />
                ))}
              </div>
            ),
          )}
        </>
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
        leute={people}
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
  kind,
  onCancel,
  onSaved,
}: {
  eventId: string;
  people: EventNotesProps['people'];
  note?: EventNoteDto;
  /** Beim Anlegen: was es werden soll. Beim Bearbeiten steht es an der Notiz. */
  kind?: NoteKind;
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
  // Beide Stufen bieten „Nur ausgewählte Personen“ an – dann braucht es auch
  // eine Liste. Ohne sie wählt man eine Stufe, bei der niemand mehr darf.
  const [adderIds, setAdderIds] = useState<string[]>(note?.adderIds ?? []);
  const [checkerIds, setCheckerIds] = useState<string[]>(note?.checkerIds ?? []);
  const [busy, setBusy] = useState(false);
  // Beim Bearbeiten steht die Art an der Notiz, beim Anlegen kommt sie vom
  // Knopf, der das Formular geoeffnet hat.
  const art: NoteKind = note?.kind ?? kind ?? 'note';

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
        adderIds?: string[];
        checkerIds?: string[];
        kind?: NoteKind;
      } = {
        title: title.trim() || undefined,
        body,
        kind: art,
      };
      // Die Rechte nur mitschicken, wenn ich sie auch bestimmen darf. Ein
      // unveraendert mitgesendeter Wert ist fuer den Server nicht von einer
      // Aenderung zu unterscheiden.
      if (binVerfasser) {
        daten.editScope = scope;
        daten.editorIds = scope === 'listed' ? editorIds : [];
        // Die beiden Listen-Rechte nur bei einer Liste. Bei einer Textnotiz
        // haetten sie ohnehin keine Wirkung – und was ohne Wirkung ist,
        // gehoert nicht ins Formular.
        if (art === 'list') {
          daten.addScope = addScope;
          daten.checkScope = checkScope;
          daten.adderIds = addScope === 'listed' ? adderIds : [];
          daten.checkerIds = checkScope === 'listed' ? checkerIds : [];
        }
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

      {/* Nur bei einer Liste. Bei einer Textnotiz sind beide Einstellungen
          ohne Wirkung – sie standen hier frueher trotzdem, hinter einer
          Klappe. Jetzt entscheidet die Art, und bei einer Liste ist das die
          Hauptsache und gehoert nicht versteckt. */}
      {art === 'list' && (
        <>

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

        {addScope === 'listed' && (
          <fieldset className="field" disabled={!binVerfasser}>
            <legend>Diese Personen</legend>
            <PersonenWahl
              label="Wer Punkte hinzufügen darf"
              vorschlaege={people}
              gewaehlt={adderIds}
              onChange={setAdderIds}
            />
          </fieldset>
        )}

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

        {checkScope === 'listed' && (
          <fieldset className="field" disabled={!binVerfasser}>
            <legend>Diese Personen</legend>
            <PersonenWahl
              label="Wer abhaken darf"
              vorschlaege={people}
              gewaehlt={checkerIds}
              onChange={setCheckerIds}
            />
          </fieldset>
        )}
        </>
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
