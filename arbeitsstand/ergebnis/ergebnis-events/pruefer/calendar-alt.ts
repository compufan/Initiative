import { z } from 'zod';
import { LIMITS, RSVP_STATUSES, type RsvpStatus } from '../constants.js';
import type { AttachmentDto } from './media.js';
import { isoDateSchema } from './common.js';

export const EVENT_STATUSES = ['planning', 'confirmed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Wer eine Notiz am Termin ändern darf. */
export const NOTE_SCOPES = ['author', 'members', 'listed'] as const;

/** Eine Notiz ist entweder ein Text oder eine Liste mit Punkten. */
export const NOTE_KINDS = ['note', 'list'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteScope = (typeof NOTE_SCOPES)[number];

export interface EventAttendeeDto {
  userId: string;
  status: RsvpStatus;
  respondedAt: string | null;
}

export interface CalendarEventDto {
  id: string;
  /** Group events belong to a conversation, personal events do not. */
  conversationId: string | null;
  createdBy: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** Simplified RRULE, e.g. `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=10`. */
  rrule: string | null;
  color: string | null;
  /** Set when the event was created from a date poll (Terminfindung). */
  sourcePollId: string | null;
  /**
   * `planning` – der Zeitpunkt wird noch abgestimmt, `startsAt` trägt so lange
   * den frühesten Vorschlag. `confirmed` – er steht fest. `cancelled` – abgesagt.
   */
  status: EventStatus;
  /** Die laufende Terminfindung, solange `status` = `planning`. */
  pollId: string | null;
  /** Die Sammlung mit den Dateien zu diesem Termin. */
  collectionId: string | null;
  attendees: EventAttendeeDto[];
  reminderMinutes: number[];
  createdAt: string;
  updatedAt: string;
}

/** A single materialised occurrence of a (possibly recurring) event. */
export interface EventOccurrence {
  event: CalendarEventDto;
  startsAt: string;
  endsAt: string;
  /** Index of this occurrence in the recurrence series (0 = first). */
  index: number;
}

export const createEventSchema = z
  .object({
    conversationId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(LIMITS.eventTitleMax),
    description: z.string().max(LIMITS.eventDescriptionMax).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    startsAt: isoDateSchema,
    endsAt: isoDateSchema,
    allDay: z.boolean().default(false),
    rrule: z.string().max(300).nullable().optional(),
    color: z.string().max(16).nullable().optional(),
    reminderMinutes: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(60 * 24 * 14),
      )
      .max(5)
      .optional(),
    /** Invite these users; conversation members are invited automatically. */
    attendeeIds: z.array(z.string().uuid()).max(200).optional(),
    /** Post an event card into the conversation (default true for group events). */
    announce: z.boolean().optional(),
  })
  .refine((v) => new Date(v.endsAt).getTime() >= new Date(v.startsAt).getTime(), {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventSchema
  .innerType()
  .partial()
  .omit({ conversationId: true });
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const listEventsSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  conversationId: z.string().uuid().optional(),
});

export const rsvpSchema = z.object({ status: z.enum(RSVP_STATUSES) });

export const eventFromPollSchema = z.object({
  optionId: z.string().uuid(),
  title: z.string().trim().min(1).max(LIMITS.eventTitleMax).optional(),
  location: z.string().max(300).nullable().optional(),
  description: z.string().max(LIMITS.eventDescriptionMax).nullable().optional(),
  /** Close the poll once the event has been created. */
  closePoll: z.boolean().default(true),
});

/**
 * Eine Notiz am Termin.
 *
 * `editScope` ist der Punkt der ganzen Sache: „Einkaufsliste, an der alle
 * mitschreiben“ und „Ansprache, an der niemand herumbessert“ sind beides
 * Notizen und sollen sich trotzdem verschieden verhalten.
 */
/** Wer abhaken darf. Eine Stufe mehr als beim Ändern. */
export type CheckScope = 'nobody' | NoteScope;

// `as const` wie bei NOTE_SCOPES: Ein blosses `CheckScope[]` ist für zod kein
// Tupel, und `z.enum()` verlangt eines.
export const CHECK_SCOPES = ['nobody', 'author', 'members', 'listed'] as const satisfies readonly CheckScope[];

export interface EventNoteItemDto {
  id: string;
  text: string;
  position: number;
  /** Wie viele müssen abhaken. 0 heisst: niemand muss. */
  requiredChecks: number;
  /** Schlägt die Zahl: alle Eingeladenen, auch die von morgen. */
  requiredAll: boolean;
  /**
   * Namentlich Zugewiesene – „das übernimmt Nora“.
   *
   * Sind welche eingetragen, schlagen sie beides: Der Punkt ist erledigt, wenn
   * genau diese abgehakt haben. Oft weiss man schon, WER, und dann ist „einer
   * muss“ die schlechtere Angabe: Es hakt irgendwer ab, und niemand weiss
   * hinterher, ob der Kuchen jetzt gebacken wird.
   */
  assigneeIds: string[];
  checkedBy: string[];
  checkedByMe: boolean;
  /** Wie viele es sein müssten – „alle“ ist hier schon aufgelöst. */
  needed: number;
  done: boolean;
}

export interface EventNoteDto {
  id: string;
  eventId: string;
  authorId: string | null;
  title: string | null;
  body: string;
  /**
   * `note` oder `list`.
   *
   * Frueher wurde das an der Punktzahl abgelesen – eine noch leere Liste war
   * damit nicht von einer Textnotiz zu unterscheiden, und jede Textnotiz trug
   * Listen-Bedienelemente.
   */
  kind: NoteKind;
  editScope: NoteScope;
  /** Bei `listed`: wer namentlich ändern darf. */
  /** Wer Punkte hinzufügen darf. */
  addScope: NoteScope;
  /** Wer abhaken darf – `nobody` für eine Liste zum Nachlesen. */
  checkScope: CheckScope;
  /** Bei `listed`: wer namentlich darf. Je Recht eine eigene Liste. */
  editorIds: string[];
  adderIds: string[];
  checkerIds: string[];
  canAdd: boolean;
  canCheck: boolean;
  /**
   * Die Punkte der Liste. Leer heisst: eine gewöhnliche Textnotiz.
   *
   * Die Soll-Zahl steht am einzelnen Punkt und nicht an der Liste, weil in
   * derselben Liste Verschiedenes stehen kann: „Zahnbürste“ muss jeder für
   * sich abhaken, „Kuchen backen“ nur einer.
   */
  items: EventNoteItemDto[];
  /** Ob **ich** sie ändern darf. Entschieden wird es auf dem Server. */
  canEdit: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventAttachmentDto {
  id: string;
  eventId: string;
  addedBy: string | null;
  title: string | null;
  attachment: AttachmentDto;
  createdAt: string;
}

/** Ein Zeitvorschlag in der Terminfindung. */
export const planningSlotSchema = z.object({
  startsAt: isoDateSchema,
  endsAt: isoDateSchema.optional(),
});

export const createPlanningSchema = z.object({
  conversationId: z.string().uuid(),
  title: z.string().trim().min(1).max(LIMITS.eventTitleMax),
  description: z.string().max(LIMITS.eventDescriptionMax).optional(),
  location: z.string().max(200).optional(),
  slots: z.array(planningSlotSchema).min(2).max(LIMITS.pollOptionsMax),
  /** Weitere Chats, in denen dieselbe Abstimmung stehen soll. */
  alsoIn: z.array(z.string().uuid()).max(50).optional(),
  closesAt: isoDateSchema.optional(),
});
export type CreatePlanningInput = z.infer<typeof createPlanningSchema>;

/**
 * Was beim Anlegen und Ändern einer Notiz hinausgeht.
 *
 * Hier standen nur `editScope` und `editorIds`, obwohl die Oberfläche längst
 * alle drei Rechte schickt. Das fiel nicht auf, weil das Blatt sein eigenes
 * Objekt baut und TypeScript die Überschussprüfung nur bei direkt notierten
 * Objekten anwendet – die Felder gingen also raus, standen aber im Vertrag
 * nicht. Auf der Gegenseite fehlten sie dann im `PATCH` wirklich, und serde
 * verwarf sie stumm.
 */
export const eventNoteSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(LIMITS.eventDescriptionMax),
  kind: z.enum(NOTE_KINDS).optional(),
  editScope: z.enum(NOTE_SCOPES).optional(),
  editorIds: z.array(z.string().uuid()).max(100).optional(),
  addScope: z.enum(NOTE_SCOPES).optional(),
  adderIds: z.array(z.string().uuid()).max(100).optional(),
  checkScope: z.enum(CHECK_SCOPES).optional(),
  checkerIds: z.array(z.string().uuid()).max(100).optional(),
});
export type EventNoteInput = z.infer<typeof eventNoteSchema>;

/** Ob ein Termin noch auf seinen Zeitpunkt wartet. */
export function isPlanning(event: Pick<CalendarEventDto, 'status'>): boolean {
  return event.status === 'planning';
}
