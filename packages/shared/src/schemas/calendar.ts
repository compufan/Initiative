import { z } from 'zod';
import { LIMITS, RSVP_STATUSES, type RsvpStatus } from '../constants.js';
import { isoDateSchema } from './common.js';

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
    reminderMinutes: z.array(z.number().int().min(0).max(60 * 24 * 14)).max(5).optional(),
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

export const updateEventSchema = createEventSchema.innerType().partial().omit({ conversationId: true });
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
