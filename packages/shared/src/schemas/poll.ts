import { z } from 'zod';
import { LIMITS, POLL_KINDS, VOTE_VALUES, type PollKind, type VoteValue } from '../constants.js';
import { isoDateSchema } from './common.js';

export interface PollOptionDto {
  id: string;
  label: string;
  /** Date polls carry a concrete slot per option. */
  startsAt: string | null;
  endsAt: string | null;
  position: number;
  createdBy: string | null;
}

export interface PollVoteDto {
  optionId: string;
  userId: string;
  value: VoteValue;
  votedAt: string;
}

export interface PollDto {
  id: string;
  conversationId: string;
  messageId: string | null;
  createdBy: string;
  kind: PollKind;
  question: string;
  description: string | null;
  multiple: boolean;
  anonymous: boolean;
  allowAddOptions: boolean;
  closesAt: string | null;
  closedAt: string | null;
  options: PollOptionDto[];
  /** Omitted for anonymous polls unless the viewer is the creator. */
  votes: PollVoteDto[];
  /** Aggregated counts per option, always present. */
  tally: Record<string, { yes: number; maybe: number; no: number; score: number }>;
  voterCount: number;
  /** The viewer's own votes, always visible to them. */
  myVotes: PollVoteDto[];
  createdEventId: string | null;
  createdAt: string;
}

const pollOptionInput = z
  .object({
    label: z.string().trim().min(1).max(LIMITS.pollOptionMax).optional(),
    startsAt: isoDateSchema.optional(),
    endsAt: isoDateSchema.optional(),
  })
  .refine((v) => v.label != null || v.startsAt != null, {
    message: 'option needs a label or a start date',
  });

export const createPollSchema = z
  .object({
    conversationId: z.string().uuid(),
    kind: z.enum(POLL_KINDS).default('choice'),
    question: z.string().trim().min(1).max(LIMITS.pollQuestionMax),
    description: z.string().max(2000).nullable().optional(),
    options: z.array(pollOptionInput).min(2).max(LIMITS.pollOptionsMax),
    multiple: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    allowAddOptions: z.boolean().default(false),
    closesAt: isoDateSchema.nullable().optional(),
  })
  .refine(
    (v) => v.kind !== 'date' || v.options.every((o) => o.startsAt != null),
    { message: 'date polls require startsAt on every option', path: ['options'] },
  );
export type CreatePollInput = z.infer<typeof createPollSchema>;

export const votePollSchema = z.object({
  votes: z
    .array(z.object({ optionId: z.string().uuid(), value: z.enum(VOTE_VALUES).default('yes') }))
    .max(LIMITS.pollOptionsMax),
});
export type VotePollInput = z.infer<typeof votePollSchema>;

export const addPollOptionSchema = pollOptionInput;
