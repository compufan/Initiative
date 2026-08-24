import type { MessageDto } from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { MessageRow } from '../db/types.js';

export type MessageExpansion = Partial<Pick<MessageDto, 'poll' | 'event' | 'game' | 'sticker'>>;
export type MessageExpansionMap = Map<string, MessageExpansion>;

export interface ExpanderInput {
  sql: Sql;
  viewerId: string;
  messages: MessageRow[];
}

/**
 * Extension point: a feature module registers an expander so its entities are
 * embedded in every message payload without the messenger core knowing about
 * polls, events or games. Adding a module never touches this file.
 */
export interface MessageExpander {
  key: string;
  expand(input: ExpanderInput): Promise<MessageExpansionMap>;
}

const expanders = new Map<string, MessageExpander>();

export function registerMessageExpander(expander: MessageExpander): void {
  expanders.set(expander.key, expander);
}

export function listMessageExpanders(): MessageExpander[] {
  return [...expanders.values()];
}

export async function runMessageExpanders(input: ExpanderInput): Promise<MessageExpansionMap> {
  if (input.messages.length === 0 || expanders.size === 0) return new Map();
  const results = await Promise.all(
    [...expanders.values()].map(async (expander) => {
      try {
        return await expander.expand(input);
      } catch {
        // A broken module must not take the whole chat down.
        return new Map<string, MessageExpansion>();
      }
    }),
  );
  const merged: MessageExpansionMap = new Map();
  for (const result of results) {
    for (const [messageId, expansion] of result) {
      merged.set(messageId, { ...(merged.get(messageId) ?? {}), ...expansion });
    }
  }
  return merged;
}
