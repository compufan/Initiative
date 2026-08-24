import type { ConversationDto, ConversationMemberDto, MessageDto } from '@initiative/shared';

/** The other side of a direct chat (null for groups). */
export function counterpartOf(
  conversation: ConversationDto,
  myId: string,
): ConversationMemberDto | null {
  if (conversation.type !== 'direct') return null;
  return (
    conversation.members.find((member) => member.userId !== myId) ?? conversation.members[0] ?? null
  );
}

export function memberName(member: ConversationMemberDto): string {
  const nickname = member.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : member.user.displayName;
}

export function conversationTitle(conversation: ConversationDto, myId: string): string {
  if (conversation.type === 'group') {
    const title = conversation.title?.trim();
    return title && title.length > 0 ? title : 'Gruppe';
  }
  const other = counterpartOf(conversation, myId);
  return other ? memberName(other) : 'Chat';
}

export interface AvatarSource {
  name: string;
  id: string;
  url: string | null;
}

/** Avatar input for a chat: the counterpart for direct chats, the group otherwise. */
export function conversationAvatar(conversation: ConversationDto, myId: string): AvatarSource {
  if (conversation.type === 'group') {
    return {
      name: conversationTitle(conversation, myId),
      id: conversation.id,
      url: conversation.avatarUrl,
    };
  }
  const other = counterpartOf(conversation, myId);
  return {
    name: other ? memberName(other) : 'Chat',
    id: other?.userId ?? conversation.id,
    url: other?.user.avatarUrl ?? null,
  };
}

export function senderName(conversation: ConversationDto | null, senderId: string | null): string {
  if (!senderId) return 'Du';
  const member = conversation?.members.find((item) => item.userId === senderId);
  return member ? memberName(member) : 'Unbekannt';
}

export function roleLabel(role: ConversationMemberDto['role']): string {
  switch (role) {
    case 'owner':
      return 'Ersteller';
    case 'admin':
      return 'Admin';
    default:
      return 'Mitglied';
  }
}

export function canModerate(conversation: ConversationDto | null, myId: string): boolean {
  const me = conversation?.members.find((member) => member.userId === myId);
  return me?.role === 'owner' || me?.role === 'admin';
}

/* ---------- dates ---------- */

const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const shortDateFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
});
const longDateFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const longDateYearFormat = new Intl.DateTimeFormat('de-DE', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days between the two dates (0 = same day, 1 = yesterday …). */
function daysAgo(iso: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  return Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
}

/** Timestamp for the chat list: time today, "Gestern", weekday, then a date. */
export function formatListStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = daysAgo(iso);
  if (diff <= 0) return timeFormat.format(date);
  if (diff === 1) return 'Gestern';
  if (diff < 7) return weekdayFormat.format(date);
  return shortDateFormat.format(date);
}

/** Separator label inside a chat. */
export function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = daysAgo(iso);
  if (diff <= 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff < 7) return weekdayFormat.format(date);
  if (date.getFullYear() === new Date().getFullYear()) return longDateFormat.format(date);
  return longDateYearFormat.format(date);
}

export function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return 'offline';
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return 'offline';
  const diff = daysAgo(lastSeenAt);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'zuletzt gesehen gerade eben';
  if (minutes < 60) return `zuletzt gesehen vor ${minutes} Min.`;
  if (diff <= 0) return `zuletzt gesehen um ${timeFormat.format(date)} Uhr`;
  if (diff === 1) return `zuletzt gesehen gestern um ${timeFormat.format(date)} Uhr`;
  return `zuletzt gesehen am ${shortDateFormat.format(date)}`;
}

export function memberCountLabel(conversation: ConversationDto): string {
  const count = conversation.members.length;
  return count === 1 ? '1 Mitglied' : `${count} Mitglieder`;
}

/* ---------- message helpers ---------- */

/** Two messages belong to the same visual group (same sender, close in time). */
export function isGrouped(previous: MessageDto | undefined, message: MessageDto): boolean {
  if (!previous) return false;
  if (previous.type === 'system' || message.type === 'system') return false;
  if (previous.senderId !== message.senderId) return false;
  if (dayKey(previous.createdAt) !== dayKey(message.createdAt)) return false;
  const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return Number.isFinite(gap) && gap < 5 * 60_000;
}

export function typingLabel(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} tippt …`;
  if (names.length === 2) return `${names[0]} und ${names[1]} tippen …`;
  return `${names.length} Personen tippen …`;
}

export function mutedLabel(mutedUntil: string | null): string | null {
  if (!mutedUntil) return null;
  const until = new Date(mutedUntil).getTime();
  if (Number.isNaN(until) || until <= Date.now()) return null;
  return 'stumm';
}
