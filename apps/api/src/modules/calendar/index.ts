import {
  buildIcsCalendar,
  createEventSchema,
  expandOccurrences,
  listEventsSchema,
  rsvpSchema,
  updateEventSchema,
  uuidSchema,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { CalendarEventRow, UserRow } from '../../db/types.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { jsonb } from '../../db/client.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { assertMembership, getMemberIds } from '../../services/conversation-core.js';
import { registerMessageExpander } from '../../services/message-expanders.js';
import {
  broadcastEvent,
  createEvent,
  eventExpander,
  loadEventDtos,
  loadEventsForUser,
  requireEvent,
} from '../../services/calendar.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });
const tokenParams = z.object({ token: z.string().min(10).max(120) });

export default defineModule({
  key: 'calendar',
  description: 'Termine, Zu-/Absagen und Kalender-Abonnement (ICS)',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql, env } = ctx;
    registerMessageExpander(eventExpander);

    app.get('/calendar/events', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const query = parseQuery(listEventsSchema, request);
      if (query.conversationId) await assertMembership(sql, query.conversationId, userId);

      const items = await loadEventsForUser(sql, userId, {
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        conversationId: query.conversationId,
      });
      return { items };
    });

    app.get('/calendar/events/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireEvent(sql, id);
      await assertEventVisible(ctx, row, userId);
      const dto = (await loadEventDtos(sql, [id])).get(id);
      if (!dto) throw notFound('Termin nicht gefunden');
      return dto;
    });

    app.post('/calendar/events', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(createEventSchema, request);
      if (input.conversationId) await assertMembership(sql, input.conversationId, userId);

      const event = await createEvent(ctx, {
        conversationId: input.conversationId ?? null,
        createdBy: userId,
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        allDay: input.allDay,
        rrule: input.rrule ?? null,
        color: input.color ?? null,
        reminderMinutes: input.reminderMinutes ?? [],
        attendeeIds: input.attendeeIds ?? [],
        announce: input.announce,
      });
      reply.status(201);
      return event;
    });

    app.patch('/calendar/events/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(updateEventSchema, request);
      const row = await requireEvent(sql, id);
      await assertEventEditable(ctx, row, userId);

      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.location !== undefined) patch.location = input.location;
      if (input.startsAt !== undefined) patch.startsAt = new Date(input.startsAt);
      if (input.endsAt !== undefined) patch.endsAt = new Date(input.endsAt);
      if (input.allDay !== undefined) patch.allDay = input.allDay;
      if (input.rrule !== undefined) patch.rrule = input.rrule;
      if (input.color !== undefined) patch.color = input.color;
      if (input.reminderMinutes !== undefined) {
        patch.reminderMinutes = jsonb(sql, input.reminderMinutes);
      }

      const startsAt = (patch.startsAt as Date | undefined) ?? row.startsAt;
      const endsAt = (patch.endsAt as Date | undefined) ?? row.endsAt;
      if (endsAt.getTime() < startsAt.getTime()) throw badRequest('Ende liegt vor dem Beginn');

      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await sql`update calendar_events set ${sql(patch)} where id = ${id}`;
      }
      if (input.attendeeIds) {
        for (const attendeeId of input.attendeeIds) {
          await sql`
            insert into event_attendees ${sql({ eventId: id, userId: attendeeId, status: 'pending' })}
            on conflict (event_id, user_id) do nothing
          `;
        }
      }

      const dto = (await loadEventDtos(sql, [id])).get(id)!;
      await broadcastEvent(ctx, dto);
      return dto;
    });

    app.delete('/calendar/events/:id', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireEvent(sql, id);
      await assertEventEditable(ctx, row, userId);

      await sql`update calendar_events set deleted_at = now() where id = ${id}`;
      const audience = new Set(
        (
          await sql<{ userId: string }[]>`select user_id from event_attendees where event_id = ${id}`
        ).map((entry) => entry.userId),
      );
      if (row.conversationId) {
        for (const memberId of await getMemberIds(sql, row.conversationId)) audience.add(memberId);
      }
      await ctx.hub.publish([...audience], {
        type: 'event.deleted',
        payload: { eventId: id, conversationId: row.conversationId },
      });
      reply.status(204);
      return null;
    });

    app.post('/calendar/events/:id/rsvp', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { status } = parseBody(rsvpSchema, request);
      const row = await requireEvent(sql, id);
      await assertEventVisible(ctx, row, userId);

      await sql`
        insert into event_attendees ${sql({
          eventId: id,
          userId,
          status,
          respondedAt: new Date(),
        })}
        on conflict (event_id, user_id) do update
        set status = excluded.status, responded_at = excluded.responded_at
      `;
      const dto = (await loadEventDtos(sql, [id])).get(id)!;
      await broadcastEvent(ctx, dto);
      return dto;
    });

    /**
     * Personal calendar feed. Authenticated by an unguessable token instead of a
     * bearer header, because calendar apps (iOS, Google, Outlook) only take URLs.
     */
    app.get('/calendar/:token/feed.ics', async (request, reply) => {
      const { token } = parseParams(tokenParams, request);
      const users = await sql<UserRow[]>`select * from users where calendar_token = ${token}`;
      const user = users[0];
      if (!user) throw notFound('Kalender nicht gefunden');

      const events = await loadEventsForUser(sql, user.id, {
        from: new Date(Date.now() - 365 * 24 * 3600 * 1000),
        to: new Date(Date.now() + 730 * 24 * 3600 * 1000),
      });
      const domain = new URL(env.PUBLIC_APP_URL).host;

      const body = buildIcsCalendar(
        events.map((event) => ({
          id: event.id,
          title: event.title,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          allDay: event.allDay,
          rrule: event.rrule,
          url: `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/kalender/termin/${event.id}`,
          createdAt: event.createdAt,
          updatedAt: event.updatedAt,
          reminderMinutes: event.reminderMinutes,
        })),
        {
          name: `Initiative – ${user.displayName}`,
          description: 'Termine aus deinen Chats und persönliche Termine',
          refreshInterval: 'PT1H',
          domain,
        },
      );

      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', 'inline; filename="initiative.ics"')
        .header('cache-control', 'private, max-age=300')
        .send(body);
    });

    /** Single event download ("zum Kalender hinzufügen"). */
    app.get('/calendar/events/:id/event.ics', async (request, reply) => {
      const { id } = parseParams(idParams, request);
      const dto = (await loadEventDtos(sql, [id])).get(id);
      if (!dto) throw notFound('Termin nicht gefunden');

      const body = buildIcsCalendar(
        [
          {
            id: dto.id,
            title: dto.title,
            description: dto.description,
            location: dto.location,
            startsAt: dto.startsAt,
            endsAt: dto.endsAt,
            allDay: dto.allDay,
            rrule: dto.rrule,
            url: `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/kalender/termin/${dto.id}`,
            createdAt: dto.createdAt,
            updatedAt: dto.updatedAt,
            reminderMinutes: dto.reminderMinutes,
          },
        ],
        { name: dto.title, domain: new URL(env.PUBLIC_APP_URL).host },
      );

      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', `attachment; filename="termin.ics"`)
        .send(body);
    });

    /** Occurrences of a recurring event, expanded for a window. */
    app.get('/calendar/events/:id/occurrences', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { from, to } = parseQuery(
        z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }),
        request,
      );
      const row = await requireEvent(sql, id);
      await assertEventVisible(ctx, row, userId);

      const windowStart = from ? new Date(from) : new Date();
      const windowEnd = to ? new Date(to) : new Date(Date.now() + 90 * 24 * 3600 * 1000);
      const occurrences = expandOccurrences(
        { startsAt: row.startsAt, endsAt: row.endsAt, rrule: row.rrule },
        windowStart,
        windowEnd,
      );
      return {
        items: occurrences.map((occurrence) => ({
          index: occurrence.index,
          startsAt: occurrence.startsAt.toISOString(),
          endsAt: occurrence.endsAt.toISOString(),
        })),
      };
    });
  },
});

async function assertEventVisible(
  ctx: AppContext,
  event: CalendarEventRow,
  userId: string,
): Promise<void> {
  if (event.createdBy === userId) return;
  if (event.conversationId) {
    await assertMembership(ctx.sql, event.conversationId, userId);
    return;
  }
  const invited = await ctx.sql<{ userId: string }[]>`
    select user_id from event_attendees where event_id = ${event.id} and user_id = ${userId}
  `;
  if (invited.length === 0) throw forbidden('Kein Zugriff auf diesen Termin');
}

async function assertEventEditable(
  ctx: AppContext,
  event: CalendarEventRow,
  userId: string,
): Promise<void> {
  if (event.createdBy === userId) return;
  if (event.conversationId) {
    const membership = await assertMembership(ctx.sql, event.conversationId, userId);
    if (membership.role !== 'member') return;
  }
  throw forbidden('Nur der Ersteller darf den Termin ändern');
}
