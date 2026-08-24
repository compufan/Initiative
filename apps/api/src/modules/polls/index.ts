import {
  LIMITS,
  addPollOptionSchema,
  bestOption,
  createPollSchema,
  eventFromPollSchema,
  isPollClosed,
  uuidSchema,
  uuidv7,
  votePollSchema,
  type RsvpStatus,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { PollOptionRow, PollRow, PollVoteRow } from '../../db/types.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { parseBody, parseParams } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { assertMembership, getMembership } from '../../services/conversation-core.js';
import { registerMessageExpander } from '../../services/message-expanders.js';
import {
  broadcastPoll,
  createPoll,
  loadPollDto,
  pollExpander,
  requirePoll,
  setVotes,
} from '../../services/polls.js';
import { createEvent } from '../../services/calendar.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });

export default defineModule({
  key: 'polls',
  description: 'Umfragen und Terminfindung',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;
    registerMessageExpander(pollExpander);

    app.post('/polls', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(createPollSchema, request);
      await assertMembership(sql, input.conversationId, userId);

      const poll = await createPoll(ctx, {
        conversationId: input.conversationId,
        createdBy: userId,
        kind: input.kind,
        question: input.question,
        description: input.description ?? null,
        multiple: input.kind === 'date' ? true : input.multiple,
        anonymous: input.anonymous,
        allowAddOptions: input.allowAddOptions,
        closesAt: input.closesAt ? new Date(input.closesAt) : null,
        options: input.options.map((option) => ({
          label: option.label,
          startsAt: option.startsAt ? new Date(option.startsAt) : undefined,
          endsAt: option.endsAt ? new Date(option.endsAt) : undefined,
        })),
      });
      reply.status(201);
      return poll;
    });

    app.get('/polls/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const poll = await requirePoll(sql, id);
      await assertMembership(sql, poll.conversationId, userId);
      return loadPollDto(sql, id, userId);
    });

    app.post('/polls/:id/vote', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { votes } = parseBody(votePollSchema, request);
      const poll = await requirePoll(sql, id);
      await assertMembership(sql, poll.conversationId, userId);
      if (isPollClosed(poll)) throw badRequest('Die Umfrage ist beendet');

      await setVotes(
        ctx,
        poll,
        userId,
        votes.map((vote) => ({ optionId: vote.optionId, value: vote.value })),
      );

      const dto = await loadPollDto(sql, id, userId);
      await broadcastPoll(ctx, dto);
      return dto;
    });

    app.post('/polls/:id/options', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(addPollOptionSchema, request);
      const poll = await requirePoll(sql, id);
      await assertMembership(sql, poll.conversationId, userId);
      if (isPollClosed(poll)) throw badRequest('Die Umfrage ist beendet');
      if (!poll.allowAddOptions && poll.createdBy !== userId) {
        throw forbidden('Hier dürfen keine Optionen ergänzt werden');
      }
      if (poll.kind === 'date' && !input.startsAt) {
        throw badRequest('Ein Terminvorschlag braucht ein Datum');
      }

      const existing = await sql<{ count: number }[]>`
        select count(*)::int as count from poll_options where poll_id = ${id}
      `;
      if ((existing[0]?.count ?? 0) >= LIMITS.pollOptionsMax) {
        throw badRequest(`Maximal ${LIMITS.pollOptionsMax} Optionen`);
      }

      await sql`
        insert into poll_options ${sql({
          id: uuidv7(),
          pollId: id,
          label: input.label ?? null,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          position: existing[0]?.count ?? 0,
          createdBy: userId,
        })}
      `;

      const dto = await loadPollDto(sql, id, userId);
      await broadcastPoll(ctx, dto);
      reply.status(201);
      return dto;
    });

    app.post('/polls/:id/close', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const poll = await requireOwnedPoll(ctx, id, userId);
      await sql`update polls set closed_at = now() where id = ${poll.id} and closed_at is null`;
      const dto = await loadPollDto(sql, id, userId);
      await broadcastPoll(ctx, dto);
      return dto;
    });

    app.post('/polls/:id/reopen', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const poll = await requireOwnedPoll(ctx, id, userId);
      await sql`update polls set closed_at = null, closes_at = null where id = ${poll.id}`;
      const dto = await loadPollDto(sql, id, userId);
      await broadcastPoll(ctx, dto);
      return dto;
    });

    /**
     * Terminfindung → Termin: turns the winning slot of a date poll into a real
     * calendar event and carries the answers over as RSVP states.
     */
    app.post('/polls/:id/event', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(eventFromPollSchema, request);
      const poll = await requireOwnedPoll(ctx, id, userId);
      if (poll.kind !== 'date') throw badRequest('Nur aus einer Terminfindung entsteht ein Termin');
      if (poll.createdEventId) throw badRequest('Aus dieser Umfrage wurde bereits ein Termin erstellt');

      const [options, votes] = await Promise.all([
        sql<PollOptionRow[]>`select * from poll_options where poll_id = ${id} order by position asc`,
        sql<PollVoteRow[]>`select * from poll_votes where poll_id = ${id}`,
      ]);

      const option = options.find((entry) => entry.id === input.optionId);
      if (!option || !option.startsAt) throw badRequest('Unbekannter Terminvorschlag');

      const attendeeStatuses: Record<string, RsvpStatus> = {};
      for (const vote of votes) {
        if (vote.optionId !== option.id) continue;
        attendeeStatuses[vote.userId] = vote.value;
      }

      const event = await createEvent(ctx, {
        conversationId: poll.conversationId,
        createdBy: userId,
        title: input.title ?? poll.question,
        description: input.description ?? poll.description ?? null,
        location: input.location ?? null,
        startsAt: option.startsAt,
        endsAt: option.endsAt ?? new Date(option.startsAt.getTime() + 60 * 60 * 1000),
        sourcePollId: poll.id,
        attendeeIds: Object.keys(attendeeStatuses),
        attendeeStatuses,
        announce: true,
      });

      await sql`
        update polls
        set created_event_id = ${event.id}
            ${input.closePoll ? sql`, closed_at = now()` : sql``}
        where id = ${poll.id}
      `;
      const dto = await loadPollDto(sql, id, userId);
      await broadcastPoll(ctx, dto);

      reply.status(201);
      return event;
    });

    /** Convenience for the UI: the currently leading option of a date poll. */
    app.get('/polls/:id/best-option', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const poll = await requirePoll(sql, id);
      await assertMembership(sql, poll.conversationId, userId);
      const dto = await loadPollDto(sql, id, userId);
      return { option: bestOption(dto.options, dto.tally) };
    });
  },
});

async function requireOwnedPoll(ctx: AppContext, pollId: string, userId: string): Promise<PollRow> {
  const poll = await requirePoll(ctx.sql, pollId);
  const membership = await getMembership(ctx.sql, poll.conversationId, userId);
  if (!membership) throw forbidden('Du bist kein Mitglied dieses Chats');
  if (poll.createdBy !== userId && membership.role === 'member') {
    throw forbidden('Nur der Ersteller darf die Umfrage verwalten');
  }
  return poll;
}
