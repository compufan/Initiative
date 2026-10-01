import { useEffect, useMemo, useState } from 'react';
import {
  LIMITS,
  describeRrule,
  uuidv7,
  type CalendarEventDto,
  type RsvpStatus,
} from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { ApiError, api } from '../../lib/api.js';
import { aktualisiert } from '../../lib/terminEreignisse.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { EinladungsWahl } from './EinladungsWahl.js';
import {
  aendernBody,
  anlegenBody,
  niemand,
  speichernText,
  vorbelegung,
  zeitOrtGeaendert,
  zeitOrtHinweis,
  type Auswahl,
} from './einladung.js';
import {
  DAY_MS,
  EVENT_COLORS,
  REMINDER_OPTIONS,
  REPEAT_OPTIONS,
  WEEKDAY_OPTIONS,
  type RepeatEnd,
  type RepeatFreq,
  type RepeatState,
  addDays,
  buildRrule,
  defaultRepeat,
  fromInputs,
  isSameDay,
  nextSlot,
  repeatFromRrule,
  toDateInput,
  toTimeInput,
  toggleWeekday,
} from './helpers.js';

interface FormState {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  color: string | null;
  reminders: number[];
  repeat: RepeatState;
}

interface EventEditorProps {
  open: boolean;
  onClose: () => void;
  /** Existing event – the editor switches to "bearbeiten". */
  event?: CalendarEventDto | null;
  /**
   * Preselected chat, e.g. when the editor is opened from the composer: Im
   * Gruppenchat sind alle Mitglieder gewählt und der Chat steht als Ziel da, im
   * Einzelchat das Gegenüber. Alles bleibt sichtbar und abwählbar.
   */
  conversationId?: string | null;
  /** Day tapped in the month grid. */
  initialDate?: Date | null;
  onSaved?: (event: CalendarEventDto) => void;
}

/** All-day events are anchored at noon so their UTC date stays correct. */
function noonOf(dateValue: string): Date | null {
  return fromInputs(dateValue, '12:00');
}

function defaultStart(initialDate: Date | null | undefined): Date {
  const now = new Date();
  if (!initialDate || isSameDay(initialDate, now)) return nextSlot(now);
  const date = new Date(initialDate.getTime());
  date.setHours(10, 0, 0, 0);
  return date;
}

function emptyForm(props: EventEditorProps): FormState {
  const start = defaultStart(props.initialDate);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    title: '',
    description: '',
    location: '',
    allDay: false,
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: toDateInput(end),
    endTime: toTimeInput(end),
    color: null,
    reminders: [],
    repeat: defaultRepeat(start),
  };
}

function formFromEvent(event: CalendarEventDto): FormState {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  return {
    title: event.title,
    description: event.description ?? '',
    location: event.location ?? '',
    allDay: event.allDay,
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: toDateInput(end),
    endTime: toTimeInput(end),
    color: event.color ?? null,
    reminders: [...event.reminderMinutes].sort((a, b) => a - b),
    repeat: repeatFromRrule(event.rrule, start),
  };
}

/** Die Wahl beim Öffnen: beim Bearbeiten die heutigen Eingeladenen, sonst die Vorbelegung des Chats. */
function startAuswahl(
  event: CalendarEventDto | null,
  props: EventEditorProps,
  myId: string,
): Auswahl {
  if (event) {
    return {
      ...niemand(),
      personen: event.attendees
        .map((teilnehmer) => teilnehmer.userId)
        .filter((userId) => userId !== myId && userId !== event.createdBy),
    };
  }
  return vorbelegung(useChat.getState().conversations, props.conversationId, myId);
}

/**
 * Create and edit a calendar event.
 *
 * Date and time are two native inputs each, because that is what iOS and
 * Android render as proper pickers; everything else (colour, reminders,
 * recurrence) is built from touch-sized chips.
 */
export function EventEditor(props: EventEditorProps) {
  const { open, onClose, event = null, onSaved } = props;
  const myId = useMyId();
  const [form, setForm] = useState<FormState>(() =>
    event ? formFromEvent(event) : emptyForm(props),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  /*
   * Die Einladung: wer, in welche Gruppenchats, und ob überhaupt eine Nachricht
   * hinausgeht. Die Liste, die Schnellwahl und die Vorschau stehen in
   * `EinladungsWahl`; hier liegt nur, was beim Speichern gebraucht wird.
   *
   * Nur der Ersteller ändert Einladungen – der Server lässt sonst niemanden
   * zu, und für alle anderen bliebe das Feld eine Falle.
   */
  const istErsteller = event == null || event.createdBy === myId;
  const [auswahl, setAuswahl] = useState<Auswahl>(() => startAuswahl(event, props, myId));
  const [senden, setSenden] = useState(true);
  const [einzelchats, setEinzelchats] = useState(true);
  /**
   * Wo der Termin schon als Karte steht. `null`, solange das nicht geladen ist:
   * Bis dahin schickt der Editor `gruppenChatIds` NICHT mit, sonst wählte er
   * bestehende Gruppenkarten versehentlich ab.
   */
  const [bestehendeGruppen, setBestehendeGruppen] = useState<string[] | null>(null);
  const [gruppenFehler, setGruppenFehler] = useState(false);
  /** Zählt die Wiederholungen des Ladens („Erneut versuchen“). */
  const [gruppenNochmal, setGruppenNochmal] = useState(0);
  /**
   * Wiederholungsschutz: Wer wegen eines Funklochs oder Doppeltippens noch
   * einmal sendet, bekommt denselben Termin zurück statt eines zweiten. Der
   * Schlüssel entsteht beim Öffnen und bleibt für alle Wiederholungen derselben
   * Eingabe.
   */
  const [clientId, setClientId] = useState(() => uuidv7());

  // Wer schon eingeladen ist, mit seiner Antwort – ohne den Ersteller, der immer dabei ist.
  const bisher = useMemo<Record<string, RsvpStatus> | undefined>(() => {
    if (!event) return undefined;
    const antworten: Record<string, RsvpStatus> = {};
    for (const teilnehmer of event.attendees) {
      if (teilnehmer.userId !== event.createdBy) antworten[teilnehmer.userId] = teilnehmer.status;
    }
    return antworten;
  }, [event]);

  const eventId = event?.id ?? null;
  const eventStamp = event?.updatedAt ?? null;

  // Re-arm the form every time the sheet opens (or another event is edited).
  // The props are only the seed of the form state, never a live dependency.
  useEffect(() => {
    if (!open) return;
    setForm(event ? formFromEvent(event) : emptyForm(props));
    setAuswahl(startAuswahl(event, props, myId));
    setSenden(true);
    setEinzelchats(true);
    setClientId(uuidv7());
    setBestehendeGruppen(null);
    setGruppenFehler(false);
    setErrors({});
    setSaving(false);
  }, [open, eventId, eventStamp]);

  // Beim Bearbeiten: in welchen Gruppenchats steht der Termin schon? Daraus
  // füllen sich die Chips, und erst danach darf der Editor die Gruppen mitschicken.
  useEffect(() => {
    if (!open || !eventId || !istErsteller) return undefined;
    let abgebrochen = false;
    api.calendar
      .zustellung(eventId)
      .then((stand) => {
        if (abgebrochen) return;
        const ids = stand.gruppen.map((karte) => karte.conversationId);
        setBestehendeGruppen(ids);
        setAuswahl((jetzt) => ({ ...jetzt, gruppen: [...new Set([...ids, ...jetzt.gruppen])] }));
      })
      .catch(() => {
        if (!abgebrochen) setGruppenFehler(true);
      });
    return () => {
      abgebrochen = true;
    };
  }, [open, eventId, eventStamp, istErsteller, gruppenNochmal]);

  const patch = (changes: Partial<FormState>) => setForm((current) => ({ ...current, ...changes }));
  const patchRepeat = (changes: Partial<RepeatState>) =>
    setForm((current) => ({ ...current, repeat: { ...current.repeat, ...changes } }));

  /** Moving the start keeps the duration: the end follows along. */
  function changeStartDate(value: string) {
    const previous = fromInputs(form.startDate, '12:00');
    const next = fromInputs(value, '12:00');
    const end = fromInputs(form.endDate, '12:00');
    if (previous && next && end && end.getTime() >= previous.getTime()) {
      const days = Math.round((next.getTime() - previous.getTime()) / DAY_MS);
      patch({ startDate: value, endDate: toDateInput(addDays(end, days)) });
      return;
    }
    patch({ startDate: value, endDate: form.endDate < value ? value : form.endDate });
  }

  function changeStartTime(value: string) {
    const previous = fromInputs(form.startDate, form.startTime);
    const next = fromInputs(form.startDate, value);
    const end = fromInputs(form.endDate, form.endTime);
    if (previous && next && end && end.getTime() >= previous.getTime()) {
      const shifted = new Date(end.getTime() + (next.getTime() - previous.getTime()));
      patch({ startTime: value, endDate: toDateInput(shifted), endTime: toTimeInput(shifted) });
      return;
    }
    patch({ startTime: value });
  }

  function toggleReminder(minutes: number) {
    setForm((current) => ({
      ...current,
      reminders: current.reminders.includes(minutes)
        ? current.reminders.filter((value) => value !== minutes)
        : [...current.reminders, minutes].sort((a, b) => a - b),
    }));
  }

  function validate(): { startsAt: Date; endsAt: Date } | null {
    const next: Record<string, string> = {};
    const title = form.title.trim();
    if (title.length === 0) next.title = 'Bitte gib dem Termin einen Titel.';
    if (title.length > LIMITS.eventTitleMax) next.title = 'Der Titel ist zu lang.';

    const startsAt = form.allDay
      ? noonOf(form.startDate)
      : fromInputs(form.startDate, form.startTime);
    const endsAt = form.allDay ? noonOf(form.endDate) : fromInputs(form.endDate, form.endTime);
    if (!startsAt) next.start = 'Bitte wähle einen Beginn.';
    if (!endsAt) next.end = 'Bitte wähle ein Ende.';
    if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
      next.end = 'Das Ende darf nicht vor dem Beginn liegen.';
    }

    if (form.repeat.freq !== 'none' && form.repeat.end === 'until') {
      const until = fromInputs(form.repeat.until, '23:59');
      if (!until) next.repeat = 'Bitte wähle ein Enddatum für die Serie.';
      else if (startsAt && until.getTime() < startsAt.getTime()) {
        next.repeat = 'Die Serie endet vor dem ersten Termin.';
      }
    }
    if (form.repeat.freq !== 'none' && form.repeat.end === 'count' && form.repeat.count < 1) {
      next.repeat = 'Eine Serie braucht mindestens einen Termin.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0 || !startsAt || !endsAt) return null;
    return { startsAt, endsAt };
  }

  async function save() {
    if (saving) return;
    const range = validate();
    if (!range) return;

    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      startsAt: range.startsAt.toISOString(),
      endsAt: range.endsAt.toISOString(),
      allDay: form.allDay,
      rrule: buildRrule(form.repeat),
      color: form.color,
      reminderMinutes: form.reminders,
    };

    // Die Einladung geht immer ausdrücklich mit: Ohne `zustellung` gälte der alte
    // Weg („alle aus dem Chat“), und die Wahl in der Liste wäre wirkungslos. Beim
    // Bearbeiten nur, was sich geändert hat – wer die Einladungen nicht anfasst,
    // sendet nichts dazu.
    const einladung = event
      ? istErsteller
        ? aendernBody(
            auswahl,
            { senden, einzelchats },
            { teilnehmer: Object.keys(bisher ?? {}), gruppen: bestehendeGruppen },
            myId,
          )
        : {}
      : anlegenBody(auswahl, { senden, einzelchats }, clientId, myId);

    setSaving(true);
    try {
      const antwort = event
        ? await api.calendar.update(event.id, { ...body, ...einladung })
        : await api.calendar.create({ ...body, ...einladung });
      // `zustellung` gehört in die Meldung, nicht in den Termin, den die
      // Ansichten halten.
      const { zustellung, ...saved } = antwort;
      // Auch an den Trichter: Die Karten in den Chats und der Kalender bekommen
      // die Fassung, selbst wenn der Rundruf nie ankommt.
      aktualisiert(saved);
      toast(
        speichernText(!event, zustellung),
        zustellung && zustellung.ausstehend > 0 ? 'error' : 'success',
      );
      onSaved?.(saved);
      onClose();
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'Termin konnte nicht gespeichert werden';
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  }

  const repeatOption = REPEAT_OPTIONS.find((option) => option.value === form.repeat.freq);
  const repeatPreview = describeRrule(buildRrule(form.repeat));

  // Wer Zeit oder Ort ändert, benachrichtigt alle Eingeladenen – der Editor sagt
  // es vor dem Speichern, nicht erst danach.
  const zusatzZeilen = useMemo(() => {
    if (!event) return [];
    const startsAt = form.allDay
      ? noonOf(form.startDate)
      : fromInputs(form.startDate, form.startTime);
    const endsAt = form.allDay ? noonOf(form.endDate) : fromInputs(form.endDate, form.endTime);
    if (!startsAt || !endsAt) return [];
    const art = zeitOrtGeaendert(event, {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      allDay: form.allDay,
      rrule: buildRrule(form.repeat),
      location: form.location.trim() || null,
    });
    return art ? [zeitOrtHinweis(art)] : [];
  }, [event, form]);

  return (
    <Sheet open={open} onClose={onClose} title={event ? 'Termin bearbeiten' : 'Neuer Termin'}>
      <div className="field">
        <label htmlFor="cal-title">Titel</label>
        <input
          id="cal-title"
          className="input"
          value={form.title}
          maxLength={LIMITS.eventTitleMax}
          placeholder="z. B. Grillen im Park"
          autoComplete="off"
          onChange={(changed) => patch({ title: changed.target.value })}
        />
        {errors.title && <p className="cal-error">{errors.title}</p>}
      </div>

      <div className="field">
        <label htmlFor="cal-location">Ort</label>
        <input
          id="cal-location"
          className="input"
          value={form.location}
          maxLength={LIMITS.eventLocationMax}
          placeholder="z. B. Stadtpark, Eingang Nord"
          autoComplete="off"
          onChange={(changed) => patch({ location: changed.target.value })}
        />
      </div>

      <label className="cal-switch">
        <span>Ganztägig</span>
        <input
          type="checkbox"
          role="switch"
          checked={form.allDay}
          onChange={(changed) => patch({ allDay: changed.target.checked })}
        />
        <span className="cal-switch-track" aria-hidden="true" />
      </label>

      <div className="cal-when">
        <div className="field">
          <label htmlFor="cal-start-date">Beginn</label>
          <div className="cal-when-row">
            <input
              id="cal-start-date"
              className="input"
              type="date"
              value={form.startDate}
              onChange={(changed) => changeStartDate(changed.target.value)}
            />
            {!form.allDay && (
              <input
                className="input"
                type="time"
                aria-label="Beginn Uhrzeit"
                value={form.startTime}
                onChange={(changed) => changeStartTime(changed.target.value)}
              />
            )}
          </div>
          {errors.start && <p className="cal-error">{errors.start}</p>}
        </div>

        <div className="field">
          <label htmlFor="cal-end-date">Ende</label>
          <div className="cal-when-row">
            <input
              id="cal-end-date"
              className="input"
              type="date"
              value={form.endDate}
              min={form.startDate}
              onChange={(changed) => patch({ endDate: changed.target.value })}
            />
            {!form.allDay && (
              <input
                className="input"
                type="time"
                aria-label="Ende Uhrzeit"
                value={form.endTime}
                onChange={(changed) => patch({ endTime: changed.target.value })}
              />
            )}
          </div>
          {errors.end && <p className="cal-error">{errors.end}</p>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="cal-description">Beschreibung</label>
        <textarea
          id="cal-description"
          className="textarea"
          value={form.description}
          maxLength={LIMITS.eventDescriptionMax}
          placeholder="Worum geht es? Was soll wer mitbringen?"
          onChange={(changed) => patch({ description: changed.target.value })}
        />
      </div>

      <div className="field">
        <span className="cal-field-label">Farbe</span>
        <div className="cal-color-row">
          <button
            type="button"
            className={`cal-color cal-color-none ${form.color == null ? 'is-active' : ''}`}
            aria-pressed={form.color == null}
            aria-label="Standardfarbe"
            onClick={() => patch({ color: null })}
          >
            ✕
          </button>
          {EVENT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              className={`cal-color ${form.color === color.value ? 'is-active' : ''}`}
              style={{ background: color.value }}
              aria-pressed={form.color === color.value}
              aria-label={color.label}
              onClick={() => patch({ color: color.value })}
            />
          ))}
        </div>
      </div>

      <div className="field">
        <span className="cal-field-label">Erinnerungen</span>
        <div className="cal-chip-row">
          {REMINDER_OPTIONS.map((option) => {
            const active = form.reminders.includes(option.minutes);
            return (
              <button
                key={option.minutes}
                type="button"
                className={`cal-chip ${active ? 'is-active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleReminder(option.minutes)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="cal-hint">
          {form.reminders.length === 0
            ? 'Ohne Erinnerung.'
            : 'Deine Kalender-App erinnert dich rechtzeitig.'}
        </p>
      </div>

      <div className="field">
        <label htmlFor="cal-repeat">Wiederholung</label>
        <select
          id="cal-repeat"
          className="select"
          value={form.repeat.freq}
          onChange={(changed) =>
            patchRepeat({ freq: changed.target.value as RepeatFreq, byDay: null })
          }
        >
          {REPEAT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {form.repeat.freq !== 'none' && (
        <div className="cal-repeat-box">
          <div className="cal-when-row">
            <label className="cal-inline-label" htmlFor="cal-interval">
              Alle
            </label>
            <input
              id="cal-interval"
              className="input cal-interval"
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={form.repeat.interval}
              onChange={(changed) => patchRepeat({ interval: Number(changed.target.value) || 1 })}
            />
            <span className="cal-inline-label">{repeatOption?.unit}</span>
          </div>

          {form.repeat.freq === 'WEEKLY' && (
            <div className="field">
              <span className="cal-field-label">An welchen Tagen</span>
              <div className="cal-chip-row" role="group" aria-label="Wochentage">
                {WEEKDAY_OPTIONS.map((option) => {
                  const active = (form.repeat.byDay ?? '').split(',').includes(option.code);
                  return (
                    <button
                      key={option.code}
                      type="button"
                      className={`cal-chip ${active ? 'is-active' : ''}`}
                      aria-pressed={active}
                      onClick={() =>
                        patchRepeat({ byDay: toggleWeekday(form.repeat.byDay, option.code) })
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <p className="cal-hint">
                {form.repeat.byDay
                  ? 'Der Termin wiederholt sich an den ausgewählten Tagen.'
                  : 'Ohne Auswahl wiederholt sich der Termin am Starttag.'}
              </p>
            </div>
          )}

          <div className="cal-segment" role="group" aria-label="Serienende">
            {(
              [
                { value: 'never', label: 'Ohne Ende' },
                { value: 'count', label: 'Nach' },
                { value: 'until', label: 'Bis' },
              ] as { value: RepeatEnd; label: string }[]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={form.repeat.end === option.value ? 'is-active' : undefined}
                aria-pressed={form.repeat.end === option.value}
                onClick={() => patchRepeat({ end: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>

          {form.repeat.end === 'count' && (
            <div className="cal-when-row">
              <input
                className="input cal-interval"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                aria-label="Anzahl der Termine"
                value={form.repeat.count}
                onChange={(changed) => patchRepeat({ count: Number(changed.target.value) || 1 })}
              />
              <span className="cal-inline-label">Terminen</span>
            </div>
          )}

          {form.repeat.end === 'until' && (
            <input
              className="input"
              type="date"
              aria-label="Serie endet am"
              value={form.repeat.until}
              min={form.startDate}
              onChange={(changed) => patchRepeat({ until: changed.target.value })}
            />
          )}

          {repeatPreview && <p className="cal-hint">Wiederholt sich {repeatPreview}.</p>}
          {errors.repeat && <p className="cal-error">{errors.repeat}</p>}
        </div>
      )}

      {/* Eingeladen. Der Teilnehmerkreis ist die Wahl hier – ein Chat verleiht
          keinen Zugang mehr, er ist nur ein Ort, an dem eine Karte steht. */}
      {/* Solange über den Zeitpunkt abgestimmt wird, lassen sich keine weiteren
          Personen einladen – sie könnten nicht abstimmen. Der Server lehnt es ab. */}
      {istErsteller && event?.status === 'planning' && (
        <p className="cal-hint">
          Weitere Personen lassen sich einladen, sobald der Zeitpunkt feststeht.
        </p>
      )}
      {istErsteller && event?.status !== 'planning' && (
        <EinladungsWahl
          myId={myId}
          auswahl={auswahl}
          onChange={setAuswahl}
          senden={senden}
          onSenden={setSenden}
          einzelchats={einzelchats}
          onEinzelchats={setEinzelchats}
          bisher={bisher}
          bestehendeGruppen={event ? bestehendeGruppen : undefined}
          gruppenFehler={gruppenFehler}
          onGruppenNochmal={() => {
            setGruppenFehler(false);
            setGruppenNochmal((zaehler) => zaehler + 1);
          }}
          zusatzZeilen={zusatzZeilen}
        />
      )}

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? 'Wird gespeichert …' : event ? 'Änderungen speichern' : 'Termin erstellen'}
      </button>
    </Sheet>
  );
}
