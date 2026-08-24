import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PollDto, VoteValue } from '@initiative/shared';
import { ApiError, api } from '../../lib/api.js';
import { realtime } from '../../lib/realtime.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { applyMyVotes } from './helpers.js';

export interface MemberInfo {
  name: string;
  avatarUrl: string | null;
}

/**
 * Display names and avatars of a chat, straight from the chat store – the poll
 * card never has to fetch a user of its own.
 */
export function useMembers(conversationId: string | null): Record<string, MemberInfo> {
  const conversations = useChat((state) => state.conversations);
  return useMemo(() => {
    const map: Record<string, MemberInfo> = {};
    const conversation = conversations.find((item) => item.id === conversationId);
    for (const member of conversation?.members ?? []) {
      const nickname = member.nickname?.trim();
      map[member.userId] = {
        name: nickname && nickname.length > 0 ? nickname : member.user.displayName,
        avatarUrl: member.user.avatarUrl,
      };
    }
    return map;
  }, [conversations, conversationId]);
}

export function memberName(
  members: Record<string, MemberInfo>,
  userId: string,
  myId: string,
): string {
  if (userId === myId) return 'Du';
  return members[userId]?.name ?? 'Unbekannt';
}

export interface LivePoll {
  poll: PollDto | null;
  loading: boolean;
  failed: boolean;
  /** A vote is on its way to the server. */
  busy: boolean;
  /** Push an authoritative copy in (close, reopen, added option, new event). */
  apply: (poll: PollDto) => void;
  submit: (votes: { optionId: string; value: VoteValue }[]) => Promise<void>;
}

/**
 * One poll, live.
 *
 * `initial` is the copy the API already expanded into the chat message, so the
 * bubble renders without a round trip; `poll.updated` keeps it current while
 * the chat is open. Own votes are applied optimistically and corrected by the
 * server answer – incoming events are ignored while a vote is in flight so a
 * slightly older broadcast cannot make the tap flicker back.
 */
export function useLivePoll(pollId: string | null, initial?: PollDto | null): LivePoll {
  const myId = useMyId();
  const [poll, setPoll] = useState<PollDto | null>(initial ?? null);
  const [loading, setLoading] = useState(Boolean(pollId) && initial == null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(0);

  useEffect(() => {
    if (!initial) return;
    if (inFlight.current > 0) return;
    setPoll(initial);
    setFailed(false);
  }, [initial]);

  useEffect(() => {
    if (!pollId || (initial && initial.id === pollId)) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.polls
      .byId(pollId)
      .then((loaded) => {
        if (!cancelled) setPoll(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pollId, initial]);

  useEffect(() => {
    if (!pollId) return undefined;
    return realtime.on('poll.updated', (payload) => {
      if (payload.poll.id !== pollId) return;
      if (inFlight.current > 0) return;
      setPoll(payload.poll);
    });
  }, [pollId]);

  const apply = useCallback((next: PollDto) => {
    setPoll(next);
    setFailed(false);
  }, []);

  const submit = useCallback(
    async (votes: { optionId: string; value: VoteValue }[]) => {
      const current = poll;
      if (!current) return;
      setPoll(applyMyVotes(current, myId, votes));
      setBusy(true);
      inFlight.current += 1;
      try {
        setPoll(await api.polls.vote(current.id, votes));
      } catch (error) {
        setPoll(current);
        toast(
          error instanceof ApiError && error.isOffline
            ? 'Keine Verbindung – deine Stimme wurde nicht gespeichert'
            : error instanceof ApiError
              ? error.message
              : 'Deine Stimme konnte nicht gespeichert werden',
          'error',
        );
      } finally {
        inFlight.current = Math.max(0, inFlight.current - 1);
        setBusy(false);
      }
    },
    [poll, myId],
  );

  return { poll, loading, failed, busy, apply, submit };
}
