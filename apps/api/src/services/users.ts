import {
  DEFAULT_USER_SETTINGS,
  accentFor,
  type SelfUserDto,
  type UserDto,
  type UserSettings,
} from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { UserRow } from '../db/types.js';
import { iso, isoRequired } from '../lib/http.js';
import { mediaUrl } from './attachments.js';

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarAttachmentId ? mediaUrl(row.avatarAttachmentId) : null,
    bio: row.bio,
    accent: accentFor(row.id),
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export function mergeSettings(stored: Partial<UserSettings> | null | undefined): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    ...(stored ?? {}),
    notifications: {
      ...DEFAULT_USER_SETTINGS.notifications,
      ...((stored?.notifications ?? {}) as UserSettings['notifications']),
    },
    modules: { ...(stored?.modules ?? {}) },
  };
}

export function toSelfUserDto(row: UserRow): SelfUserDto {
  return {
    ...toUserDto(row),
    calendarToken: row.calendarToken,
    settings: mergeSettings(row.settings),
  };
}

export async function loadUsersByIds(sql: Sql, ids: string[]): Promise<Map<string, UserDto>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await sql<UserRow[]>`select * from users where id = any(${unique})`;
  return new Map(rows.map((row) => [row.id, toUserDto(row)]));
}

export async function getUserRow(sql: Sql, id: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`select * from users where id = ${id}`;
  return rows[0] ?? null;
}

export async function touchLastSeen(sql: Sql, userId: string): Promise<void> {
  await sql`update users set last_seen_at = now() where id = ${userId}`;
}
