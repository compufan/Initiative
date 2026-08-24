import { z } from 'zod';
import { LIMITS } from '../constants.js';

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  /** Deterministic accent colour derived from the id, used for avatar fallbacks. */
  accent: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SelfUserDto extends UserDto {
  /** Opaque token for the personal ICS calendar feed. */
  calendarToken: string;
  settings: UserSettings;
}

export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  locale: string;
  notifications: {
    push: boolean;
    sound: boolean;
    previews: boolean;
  };
  /** Per-module preferences; unknown keys are preserved so new modules can extend. */
  modules: Record<string, unknown>;
}

export const userSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  locale: z.string().min(2).max(16).optional(),
  notifications: z
    .object({ push: z.boolean(), sound: z.boolean(), previews: z.boolean() })
    .partial()
    .optional(),
  modules: z.record(z.unknown()).optional(),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  bio: z.string().trim().max(LIMITS.bioMax).nullable().optional(),
  avatarAttachmentId: z.string().uuid().nullable().optional(),
  settings: userSettingsSchema.optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const userSearchSchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: 'system',
  locale: 'de',
  notifications: { push: true, sound: true, previews: true },
  modules: {},
};

const ACCENTS = [
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a855f7',
  '#6366f1',
  '#0ea5e9',
  '#14b8a6',
  '#22c55e',
  '#eab308',
  '#78716c',
];

/** Stable colour for avatar placeholders – same input always yields same colour. */
export function accentFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return ACCENTS[hash % ACCENTS.length]!;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
