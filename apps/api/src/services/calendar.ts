import {
  expandOccurrences,
  uuidv7,
  type CalendarEventDto,
  type EventAttendeeDto,
  type RsvpStatus,
} from '@initiative/shared';
import type { AppContext } from '../context.js';
import { jsonb, type Sql } from '../db/client.js';
import type { CalendarEventRow, EventAttendeeRow } from '../db/types.js';
import { groupBy, iso, isoRequired } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { getMemberIds } from './conversation-core.js';
import { createMessage } from './messages.js';
import type { MessageExpander } from './message-expanders.js';

export function toEventDto(row: CalendarEventRow, attendees: EventAttendeeRow[]): CalendarEventDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    createdBy: row.createdBy ?? '',
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: isoRequired(row.startsAt),
    endsAt: isoRequired(row.endsAt),
    allDay: row.allDay,
    rrule: row.rrule,
    color: row.color,
    sourcePollId: row.sourcePollId,
    attendees: attendees.map(toAttendeeDto),
    reminderMinutes: row.reminderMinutes ?? [],
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toAttendeeDto(row: EventAttendeeRow): EventAttendeeDto {
  return { userId: row.userId, status: row.status, respondedAt: iso(row.respondedAt) };
}

export async function loadEventDtos(sql: Sql, eventIds: string[]): Promise<Map<string, CalendarEventDto>> {
  if (eventIds.length === 0) return new Map();
  const [rows, attendees] = await Promise.all([
    sql<CalendarEventRow[]>`select * from calendar_events where id = any(${eventIds}) and deleted_at is null`,
    sql<EventAttendeeRow[]>`select * from event_attendees where event_id = any(${eventIds})`,
  ]);
  const byEvent = groupBy(attendees, (row) => row.eventId);
  return new Map(rows.map((row) => [row.id, toEventDto(row, byEvent.get(row.id) ?? [])]));
}

export async function requireEvent(sql: Sql, eventId: string): Promise<CalendarEventRow> {
  const rows = await sql<CalendarEventRow[]>`
    select * from calendar_events where id = ${eventId} and deleted_at is null
  `;
  const row = rows[0];
  if (!row) throw notFound('Termin nicht gefunden');
  return row;
}

/**
 * Every event the user can see in a window: personal events, events of their
 * chats and events they were invited to. Recurring events are kept as a single
 * row – they are returned when *any* occurrence falls into the window, and the
 * client expands them with `expandOccurrences` from `@initiative/shared`.
 */
export async function loadEventsForUser(
  sql: Sql,
  userId: string,
  options: { from?: Date; to?: Date; conversationId?: string } = {},
): Promise<CalendarEventDto[]> {
  const from = options.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const to = options.to ?? new Date(Date.now() + 180 * 24 * 3600 * 1000);

  const rows = await sql<CalendarEventRow[]>`
    select distinct e.*
    from calendar_events e
    left join conversation_members cm
      on cm.conversation_id = e.conversation_id and cm.user_id = ${userId}
    left join event_attendees ea on ea.event_id = e.id and ea.user_id = ${userId}
    where e.deleted_at is null
      and (e.created_by = ${userId} or cm.user_id is not null or ea.user_id is not null)
      ${options.conversationId ? sql`and e.conversation_id = ${options.conversationId}` : sql``}
      and (
        e.rrule is not null
        or (e.starts_at <= ${to} and e.ends_at >= ${from})
      )
    order by e.starts_at asc
    limit 1000
  `;

  const inWindow = rows.filter((row) => {
    if (!row.rrule) return true;
    return (
      expandOccurrences({ startsAt: row.startsAt, endsAt: row.endsAt, rrule: row.rrule }, from, to)
        .length > 0
    );
  });

  const attendees =
    inWindow.length > 0
      ? await sql<EventAttendeeRow[]>`
          select * from event_attendees where event_id = any(${inWindow.map((row) => row.id)})
        `
      : [];
  const byEvent = groupBy(attendees, (row) => row.eventId);
  return inWindow.map((row) => toEventDto(row, byEvent.get(row.id) ?? []));
}

export interface CreateEventInputInternal {
  conversationId?: string | null;
  createdBy: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  rrule?: string | null;
  color?: string | null;
  reminderMinutes?: number[];
  sourcePollId?: string | null;
  attendeeIds?: string[];
  /** Post an event card into the conversation (default: yes for group events). */
  announce?: boolean;
  /** Pre-set RSVP answers, e.g. taken over from a date poll. */
  attendeeStatuses?: Record<string, RsvpStatus>;
}

/**
 * Shared by the calendar module and by "Termin aus Umfrage erstellen" – both
 * produce the same rows, the same chat card and the same realtime event.
 */
export async function createEvent(
  ctx: AppContext,
  input: CreateEventInputInternal,
): Promise<CalendarEventDto> {
  const { sql } = ctx;
  const eventId = uuidv7();

  const attendeeIds = new Set<string>(input.attendeeIds ?? []);
  attendeeIds.add(input.createdBy);
  if (input.conversationId) {
    for (const memberId of await getMemberIds(sql, input.conversationId)) attendeeIds.add(memberId);
  }

  await sql`
    insert into calendar_events ${sql({
      id: eventId,
      conversationId: input.conversationId ?? null,
      createdBy: input.createdBy,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      rrule: input.rrule ?? null,
      color: input.color ?? null,
      reminderMinutes: jsonb(sql, input.reminderMinutes ?? []),
      sourcePollId: input.sourcePollId ?? null,
    })}
  `;

  for (const userId of attendeeIds) {
    const status: RsvpStatus =
      userId === input.createdBy ? 'yes' : (input.attendeeStatuses?.[userId] ?? 'pending');
    await sql`
      insert into event_attendees ${sql({
        eventId,
        userId,
        status,
        respondedAt: status === 'pending' ? null : new Date(),
      })}
      on conflict (event_id, user_id) do update set status = excluded.status
    `;
  }

  const announce = input.announce ?? Boolean(input.conversationId);
  if (announce && input.conversationId) {
    const message = await createMessage(ctx, {
      conversationId: input.conversationId,
      senderId: input.createdBy,
      type: 'event',
      body: null,
      metadata: { eventId },
    });
    await sql`update calendar_events set message_id = ${message.id} where id = ${eventId}`;
  }

  const dto = (await loadEventDtos(sql, [eventId])).get(eventId)!;
  await broadcastEvent(ctx, dto);
  return dto;
}

/** Tell every participant (chat members + invitees) that an event changed. */
export async function broadcastEvent(ctx: AppContext, event: CalendarEventDto): Promise<void> {
  const audience = new Set(event.attendees.map((attendee) => attendee.userId));
  if (event.conversationId) {
    for (const memberId of await getMemberIds(ctx.sql, event.conversationId)) audience.add(memberId);
  }
  await ctx.hub.publish([...audience], { type: 'event.updated', payload: { event } });
}

/** Embeds the referenced event into every `event` message. */
export const eventExpander: MessageExpander = {
  key: 'calendar',
  async expand({ sql, messages }) {
    const eventIds = [
      ...new Set(
        messages.map((message) => message.metadata?.eventId).filter((id): id is string => !!id),
      ),
    ];
    const events = await loadEventDtos(sql, eventIds);
    const result = new Map<string, { event?: CalendarEventDto }>();
    for (const message of messages) {
      const eventId = message.metadata?.eventId;
      if (!eventId) continue;
      const event = events.get(eventId);
      if (event) result.set(message.id, { event });
    }
    return result;
  },
};
