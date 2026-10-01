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
  /**
   * Zählt jede Änderung hoch, auch Zu- und Absagen. Wer zwei Fassungen
   * desselben Termins hat, nimmt die mit dem höheren Stand: Rundrufe können
   * einander überholen.
   */
  stand: number;
  createdAt: string;
  updatedAt: string;
}

/** Eine Gruppenkarte: der Chat und die Nachricht darin. */
export interface GruppenKarteDto {
  conversationId: string;
  /** Leer, solange die Nachricht noch nicht angelegt ist. */
  nachrichtId: string | null;
}

/** Was aus einer Einladung geworden ist – die Antwort auf Anlegen und Ändern. */
export interface ZustellungDto {
  /** Die Gruppenchats, in denen jetzt eine Karte steht. */
  gruppen: GruppenKarteDto[];
  /** Karten in Einzelchats, die diese Anfrage zugestellt hat. */
  einzelchats: number;
  /** Davon Einzelchats, die dafür neu angelegt wurden. */
  neueEinzelchats: number;
  /** Gewünschte Gruppenchats, in denen nicht alle Mitglieder eingeladen sind (höchstens fünf Fehlende je Chat). */
  ausgelassen: { conversationId: string; fehlend: string[] }[];
  /** Karten, die (noch) nicht zugestellt sind; `nachliefern` holt sie nach. */
  ausstehend: number;
  /** Personen, die eine Benachrichtigung bekommen haben. */
  benachrichtigt: number;
}

/**
 * Anlegen und Ändern liefern den Termin auf oberster Ebene, dazu – wenn
 * `zustellung` oder `attendeeIds` gesendet wurde – was daraus geworden ist.
 */
export type TerminAntwort = CalendarEventDto & { zustellung?: ZustellungDto };

/** Wo ein Termin als Karte steht: `GET /calendar/events/{id}/zustellung`. */
export interface ZustellungStandDto {
  gruppen: GruppenKarteDto[];
  /** Wer schon eine Karte im Einzelchat hat. */
  einzelNutzerIds: string[];
  ausstehend: number;
}

/** A single materialised occurrence of a (possibly recurring) event. */
export interface EventOccurrence {
  event: CalendarEventDto;
  startsAt: string;
  endsAt: string;
  /** Index of this occurrence in the recurrence series (0 = first). */
  index: number;
}

/**
 * Wie eine Einladung zugestellt wird. Fehlt das Feld beim Anlegen, gilt der alte
 * Weg: `conversationId` bestimmt den Chat, alle seine Mitglieder werden
 * eingeladen, eine Karte kommt dorthin. Mit dem Feld ist `attendeeIds` die
 * **volle** Liste (ohne den Ersteller), und leer heisst: niemand.
 */
export const zustellungSchema = z.object({
  /** `false`: niemand bekommt eine Karte oder Benachrichtigung; nur Kalender. */
  senden: z.boolean().default(true),
  /** Karte in die Einzelchats. */
  einzelchats: z.boolean().default(true),
  /** Gruppenchats, in die die Karte soll – nur dort, wo alle Mitglieder eingeladen sind. */
  gruppenChatIds: z.array(z.string().uuid()).max(LIMITS.einladungGruppenMax).default([]),
});
export type ZustellungInput = z.infer<typeof zustellungSchema>;

/**
 * Beim Ändern gelten `senden` und `einzelchats` für die **neu Hinzugefügten**
 * dieser Anfrage. `gruppenChatIds` ist der Sollzustand der Gruppenkarten;
 * **fehlt es, bleibt alles unverändert** – der Editor schickt es erst, wenn er
 * die bestehenden Karten kennt, sonst wählte er sie versehentlich ab.
 */
export const zustellungAendernSchema = z.object({
  senden: z.boolean().optional(),
  einzelchats: z.boolean().optional(),
  gruppenChatIds: z.array(z.string().uuid()).max(LIMITS.einladungGruppenMax).optional(),
});
export type ZustellungAendernInput = z.infer<typeof zustellungAendernSchema>;

export const createEventSchema = z
  .object({
    conversationId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(LIMITS.eventTitleMax),
    description: z.string().max(LIMITS.eventDescriptionMax).nullable().optional(),
    location: z.string().max(LIMITS.eventLocationMax).nullable().optional(),
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
    /**
     * Invite these users. Ohne `zustellung` kommen alle Mitglieder des Chats
     * automatisch dazu; mit `zustellung` ist es die volle Liste.
     */
    attendeeIds: z.array(z.string().uuid()).max(LIMITS.einladungenMax).optional(),
    /** Post an event card into the conversation (default true for group events). */
    announce: z.boolean().optional(),
    zustellung: zustellungSchema.optional(),
    /**
     * Wiederholungsschutz: Wer denselben Schlüssel noch einmal schickt
     * (Funkloch, Doppeltipp), bekommt den schon angelegten Termin zurück.
     */
    clientId: z.string().min(1).max(LIMITS.eventClientIdMax).optional(),
  })
  .refine((v) => new Date(v.endsAt).getTime() >= new Date(v.startsAt).getTime(), {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventSchema
  .innerType()
  .partial()
  .omit({ conversationId: true, zustellung: true, clientId: true, announce: true })
  .extend({
    zustellung: zustellungAendernSchema.optional(),
    /** Absagen und Wiederaufnehmen; nicht aus oder nach `planning`. */
    status: z.enum(['confirmed', 'cancelled']).optional(),
  });
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
  location: z.string().max(LIMITS.eventLocationMax).nullable().optional(),
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
export const CHECK_SCOPES = [
  'nobody',
  'author',
  'members',
  'listed',
] as const satisfies readonly CheckScope[];

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
