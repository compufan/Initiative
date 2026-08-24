import {
  countVoters,
  tallyVotes,
  uuidv7,
  type PollDto,
  type PollKind,
  type PollOptionDto,
  type PollVoteDto,
  type VoteValue,
} from '@initiative/shared';
import type { AppContext } from '../context.js';
import type { Sql } from '../db/client.js';
import type { PollOptionRow, PollRow, PollVoteRow } from '../db/types.js';
import { groupBy, iso, isoRequired } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { getMemberIds } from './conversation-core.js';
import { createMessage, republishMessage } from './messages.js';
import type { MessageExpander } from './message-expanders.js';

function toOptionDto(row: PollOptionRow): PollOptionDto {
  return {
    id: row.id,
    label: row.label ?? '',
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    position: row.position,
    createdBy: row.createdBy,
  };
}

function toVoteDto(row: PollVoteRow): PollVoteDto {
  return {
    optionId: row.optionId,
    userId: row.userId,
    value: row.value,
    votedAt: isoRequired(row.votedAt),
  };
}

export function toPollDto(
  poll: PollRow,
  options: PollOptionRow[],
  votes: PollVoteRow[],
  viewerId: string,
): PollDto {
  const optionDtos = options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(toOptionDto);
  const voteDtos = votes.map(toVoteDto);
  const myVotes = voteDtos.filter((vote) => vote.userId === viewerId);
  // Anonymous polls only reveal aggregates – except to the creator.
  const revealVotes = !poll.anonymous || poll.createdBy === viewerId;

  return {
    id: poll.id,
    conversationId: poll.conversationId,
    messageId: poll.messageId,
    createdBy: poll.createdBy ?? '',
    kind: poll.kind,
    question: poll.question,
    description: poll.description,
    multiple: poll.multiple,
    anonymous: poll.anonymous,
    allowAddOptions: poll.allowAddOptions,
    closesAt: iso(poll.closesAt),
    closedAt: iso(poll.closedAt),
    options: optionDtos,
    votes: revealVotes ? voteDtos : [],
    tally: tallyVotes(optionDtos, voteDtos),
    voterCount: countVoters(voteDtos),
    myVotes,
    createdEventId: poll.createdEventId,
    createdAt: isoRequired(poll.createdAt),
  };
}

export async function loadPollDtos(
  sql: Sql,
  pollIds: string[],
  viewerId: string,
): Promise<Map<string, PollDto>> {
  if (pollIds.length === 0) return new Map();
  const [polls, options, votes] = await Promise.all([
    sql<PollRow[]>`select * from polls where id = any(${pollIds})`,
    sql<PollOptionRow[]>`select * from poll_options where poll_id = any(${pollIds}) order by position asc`,
    sql<PollVoteRow[]>`select * from poll_votes where poll_id = any(${pollIds})`,
  ]);
  const optionsByPoll = groupBy(options, (row) => row.pollId);
  const votesByPoll = groupBy(votes, (row) => row.pollId);
  return new Map(
    polls.map((poll) => [
      poll.id,
      toPollDto(poll, optionsByPoll.get(poll.id) ?? [], votesByPoll.get(poll.id) ?? [], viewerId),
    ]),
  );
}

export async function loadPollDto(sql: Sql, pollId: string, viewerId: string): Promise<PollDto> {
  const dto = (await loadPollDtos(sql, [pollId], viewerId)).get(pollId);
  if (!dto) throw notFound('Umfrage nicht gefunden');
  return dto;
}

export async function requirePoll(sql: Sql, pollId: string): Promise<PollRow> {
  const rows = await sql<PollRow[]>`select * from polls where id = ${pollId}`;
  const row = rows[0];
  if (!row) throw notFound('Umfrage nicht gefunden');
  return row;
}

export interface CreatePollInputInternal {
  conversationId: string;
  createdBy: string;
  kind: PollKind;
  question: string;
  description?: string | null;
  multiple: boolean;
  anonymous: boolean;
  allowAddOptions: boolean;
  closesAt?: Date | null;
  options: { label?: string; startsAt?: Date; endsAt?: Date }[];
}

export async function createPoll(ctx: AppContext, input: CreatePollInputInternal): Promise<PollDto> {
  const { sql } = ctx;
  const pollId = uuidv7();

  await sql`
    insert into polls ${sql({
      id: pollId,
      conversationId: input.conversationId,
      createdBy: input.createdBy,
      kind: input.kind,
      question: input.question,
      description: input.description ?? null,
      multiple: input.multiple,
      anonymous: input.anonymous,
      allowAddOptions: input.allowAddOptions,
      closesAt: input.closesAt ?? null,
    })}
  `;

  let position = 0;
  for (const option of input.options) {
    await sql`
      insert into poll_options ${sql({
        id: uuidv7(),
        pollId,
        label: option.label ?? null,
        startsAt: option.startsAt ?? null,
        endsAt: option.endsAt ?? null,
        position: position++,
        createdBy: input.createdBy,
      })}
    `;
  }

  const message = await createMessage(ctx, {
    conversationId: input.conversationId,
    senderId: input.createdBy,
    type: 'poll',
    body: null,
    metadata: { pollId },
  });
  await sql`update polls set message_id = ${message.id} where id = ${pollId}`;

  const dto = await loadPollDto(sql, pollId, input.createdBy);
  await broadcastPoll(ctx, dto);
  return dto;
}

/** Replace the viewer's votes; single-choice polls keep exactly one entry. */
export async function setVotes(
  ctx: AppContext,
  poll: PollRow,
  userId: string,
  votes: { optionId: string; value: VoteValue }[],
): Promise<void> {
  const { sql } = ctx;
  const validOptions = new Set(
    (await sql<{ id: string }[]>`select id from poll_options where poll_id = ${poll.id}`).map(
      (row) => row.id,
    ),
  );
  const accepted = votes.filter((vote) => validOptions.has(vote.optionId));
  const limited = poll.multiple || poll.kind === 'date' ? accepted : accepted.slice(0, 1);

  await sql.begin(async (tx) => {
    await tx`delete from poll_votes where poll_id = ${poll.id} and user_id = ${userId}`;
    for (const vote of limited) {
      await tx`
        insert into poll_votes ${tx({
          pollId: poll.id,
          optionId: vote.optionId,
          userId,
          value: vote.value,
        })}
      `;
    }
  });
}

/** Push the updated poll to everyone and refresh its chat card. */
export async function broadcastPoll(ctx: AppContext, poll: PollDto): Promise<void> {
  const memberIds = await getMemberIds(ctx.sql, poll.conversationId);
  await Promise.all(
    memberIds.map(async (userId) => {
      const view = await loadPollDto(ctx.sql, poll.id, userId);
      await ctx.hub.publish([userId], { type: 'poll.updated', payload: { poll: view } });
    }),
  );
  await republishMessage(ctx, poll.messageId, poll.createdBy);
}

/** Embeds the referenced poll into every `poll` message. */
export const pollExpander: MessageExpander = {
  key: 'polls',
  async expand({ sql, viewerId, messages }) {
    const pollIds = [
      ...new Set(messages.map((message) => message.metadata?.pollId).filter((id): id is string => !!id)),
    ];
    const polls = await loadPollDtos(sql, pollIds, viewerId);
    const result = new Map<string, { poll?: PollDto }>();
    for (const message of messages) {
      const pollId = message.metadata?.pollId;
      if (!pollId) continue;
      const poll = polls.get(pollId);
      if (poll) result.set(message.id, { poll });
    }
    return result;
  },
};
