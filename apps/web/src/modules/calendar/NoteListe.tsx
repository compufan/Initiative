import { useState } from 'react';
import type { EventNoteDto, EventNoteItemDto } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { PersonenWahl, type Person } from '../../components/PersonenWahl.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';

interface Props {
  eventId: string;
  note: EventNoteDto;
  onChanged: (note: EventNoteDto) => void;
  /** Wer eingeladen ist – für die Auswahl „wie viele“ und „wer namentlich“. */
  leute: Person[];
}

/**
 * Die Liste in einer Notiz: Packliste, Aufgabenliste.
 *
 * Der Kern ist die Soll-Zahl am **einzelnen Punkt**, nicht an der Liste. In
 * derselben Packliste kann „Zahnbürste“ von jedem einzeln abzuhaken sein – es
 * geht um sein eigenes Gepäck – während „Kuchen backen“ nur einer erledigen
 * muss. Eine Liste mit einer gemeinsamen Regel könnte das nicht abbilden.
 *
 * „Alle“ ist keine Zahl, sondern die Einladungsliste. Wer später dazukommt,
 * muss ebenfalls abhaken; deshalb rechnet der Server das aus und nicht die App.
 */
export function NoteListe({ eventId, note, onChanged, leute }: Props) {
  const eingeladene = leute.length;
  const name = (id: string) => leute.find((person) => person.id === id)?.displayName ?? 'Unbekannt';
  const [neuerText, setNeuerText] = useState('');
  const [busy, setBusy] = useState(false);
  const myId = useMyId();

  async function ruf(aufgabe: () => Promise<EventNoteDto>) {
    setBusy(true);
    try {
      onChanged(await aufgabe());
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nicht gespeichert');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Abhaken – sofort sichtbar, dann bestätigt.
   *
   * Ein Kästchen, das erst nach der Antwort des Servers umspringt, fühlt sich
   * kaputt an: Man tippt, nichts passiert, man tippt noch einmal. Deshalb wird
   * der Haken zuerst hier gesetzt und danach mit dem abgeglichen, was der
   * Server sagt. Geht es schief, springt er zurück – lieber ein kurzes
   * Zucken als eine Liste, die etwas anderes behauptet als die Datenbank.
   */
  async function abhaken(punkt: EventNoteItemDto, an: boolean) {
    const vorher = note;
    onChanged(oertlichAbhaken(note, punkt.id, myId, an, eingeladene));
    try {
      onChanged(await api.calendar.checkNoteItem(eventId, note.id, punkt.id, an));
    } catch (error) {
      onChanged(vorher);
      toast(error instanceof Error ? error.message : 'Nicht gespeichert');
    }
  }

  async function hinzufuegen() {
    const text = neuerText.trim();
    if (!text) return;
    setNeuerText('');
    await ruf(() => api.calendar.addNoteItem(eventId, note.id, { text }));
  }

  if (note.items.length === 0 && !note.canAdd) return null;

  return (
    <div className="nl">
      <ul className="nl-liste">
        {note.items.map((punkt) => (
          <NotePunkt
            key={punkt.id}
            punkt={punkt}
            note={note}
            eventId={eventId}
            eingeladene={eingeladene}
            busy={busy}
            leute={leute}
            name={name}
            ruf={ruf}
            onCheck={abhaken}
          />
        ))}
      </ul>

      {note.canAdd && (
        <div className="nl-neu">
          <input
            className="input"
            value={neuerText}
            placeholder="Punkt hinzufügen …"
            maxLength={500}
            disabled={busy}
            onChange={(änderung) => setNeuerText(änderung.target.value)}
            onKeyDown={(taste) => {
              if (taste.key === 'Enter') {
                taste.preventDefault();
                void hinzufuegen();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || neuerText.trim().length === 0}
            onClick={() => void hinzufuegen()}
          >
            Hinzufügen
          </button>
        </div>
      )}
    </div>
  );
}

function NotePunkt({
  punkt,
  note,
  eventId,
  eingeladene,
  busy,
  leute,
  name,
  ruf,
  onCheck,
}: {
  punkt: EventNoteItemDto;
  note: EventNoteDto;
  eventId: string;
  eingeladene: number;
  busy: boolean;
  leute: Person[];
  name: (id: string) => string;
  ruf: (aufgabe: () => Promise<EventNoteDto>) => Promise<void>;
  onCheck: (punkt: EventNoteItemDto, an: boolean) => void | Promise<void>;
}) {
  const myId = useMyId();
  const [offen, setOffen] = useState(false);

  const wer = punkt.checkedBy.map((id) => (id === myId ? 'Du' : name(id))).join(', ');

  return (
    <li className={punkt.done ? 'nl-punkt is-fertig' : 'nl-punkt'}>
      <label className="nl-haken">
        <input
          type="checkbox"
          checked={punkt.checkedByMe}
          disabled={!note.canCheck}
          onChange={(änderung) => void onCheck(punkt, änderung.target.checked)}
        />
        <span className="nl-text">{punkt.text}</span>
      </label>

      {/* Wie weit ist der Punkt? Nur zeigen, wenn ueberhaupt jemand muss –
          sonst steht an einer schlichten Zeile eine sinnlose 0 von 0. */}
      {/* Sind Leute namentlich zustaendig, sind SIE die Auskunft – nicht eine
          Zahl. „2 von 3“ sagt einem nicht, ob der Kuchen gebacken wird. */}
      {punkt.assigneeIds.length > 0 ? (
        <span className="nl-stand" title={wer ? `Abgehakt von ${wer}` : 'Noch niemand'}>
          {punkt.assigneeIds
            .map((id) => `${id === myId ? 'Du' : name(id)}${punkt.checkedBy.includes(id) ? ' ✓' : ''}`)
            .join(', ')}
        </span>
      ) : (
        punkt.needed > 0 && (
          <span className="nl-stand" title={wer ? `Abgehakt von ${wer}` : 'Noch niemand'}>
            {punkt.checkedBy.length} von {punkt.needed}
            {punkt.requiredAll ? ' (alle)' : ''}
          </span>
        )
      )}

      {note.canEdit && (
        <button
          type="button"
          className="icon-btn nl-mehr"
          aria-label={`Einstellungen für „${punkt.text}“`}
          aria-expanded={offen}
          onClick={() => setOffen((wert) => !wert)}
        >
          ⋯
        </button>
      )}

      {offen && note.canEdit && (
        <div className="nl-einstellung">
          {/* Wer namentlich zustaendig ist, schlaegt die Zahl – deshalb ist
              die Zahl dann ausgegraut statt versteckt: Man soll sehen, dass
              es sie gibt und warum sie gerade nichts tut. */}
          <label htmlFor={`soll-${punkt.id}`}>Abhaken müssen</label>
          <select
            id={`soll-${punkt.id}`}
            className="select"
            disabled={busy || punkt.assigneeIds.length > 0}
            value={punkt.requiredAll ? 'alle' : String(punkt.requiredChecks)}
            onChange={(änderung) => {
              const wert = änderung.target.value;
              void ruf(() =>
                api.calendar.updateNoteItem(eventId, note.id, punkt.id, {
                  requiredAll: wert === 'alle',
                  requiredChecks: wert === 'alle' ? 0 : Number(wert),
                }),
              );
            }}
          >
            {/*
              Von „niemand“ bis „alle“. Mehr als alle geht nicht – bei fünf
              Leuten steht deshalb keinmal, 1×, 2×, 3×, 4× und Alle zur Wahl,
              aber kein 5×: Das wäre dasselbe wie „alle“, nur ohne
              mitzuwachsen, wenn jemand dazukommt.
            */}
            <option value="0">niemand</option>
            {Array.from({ length: Math.max(0, eingeladene - 1) }, (_, i) => i + 1).map((zahl) => (
              <option key={zahl} value={zahl}>
                {zahl}
                {zahl === 1 ? ' Person' : ' Personen'}
              </option>
            ))}
            <option value="alle">alle Eingeladenen</option>
          </select>

          <div className="nl-zustaendig">
            <span className="nl-zustaendig-titel">Oder namentlich:</span>
            <PersonenWahl
              label={`Wer „${punkt.text}“ übernimmt`}
              vorschlaege={leute}
              gewaehlt={punkt.assigneeIds}
              suchbar={false}
              onChange={(ids) =>
                void ruf(() =>
                  api.calendar.updateNoteItem(eventId, note.id, punkt.id, { assigneeIds: ids }),
                )
              }
            />
          </div>

          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() =>
              void ruf(() => api.calendar.removeNoteItem(eventId, note.id, punkt.id))
            }
          >
            Punkt löschen
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Den Haken örtlich setzen, damit die Liste sofort stimmt.
 *
 * Rechnet dieselben zwei Dinge nach, die auch der Server ausrechnet: wie viele
 * abgehakt haben und ob der Punkt damit erledigt ist. Das ist eine Kopie der
 * Regel und damit eine Stelle, die auseinanderlaufen kann – deshalb gilt sie
 * nur bis zur Antwort, die sie sofort wieder überschreibt.
 */
function oertlichAbhaken(
  note: EventNoteDto,
  itemId: string,
  myId: string,
  an: boolean,
  eingeladene: number,
): EventNoteDto {
  return {
    ...note,
    items: note.items.map((punkt) => {
      if (punkt.id !== itemId) return punkt;
      const checkedBy = an
        ? [...new Set([...punkt.checkedBy, myId])]
        : punkt.checkedBy.filter((id) => id !== myId);
      const needed = punkt.requiredAll ? eingeladene : punkt.requiredChecks;
      return {
        ...punkt,
        checkedBy,
        checkedByMe: an,
        needed,
        done: needed > 0 && checkedBy.length >= needed,
      };
    }),
  };
}
