import { DEFAULT_USER_SETTINGS, type SelfUserDto, type UserSettings } from '@initiative/shared';
import { api } from '../../lib/api.js';
import type { ConnectionState } from '../../lib/realtime.js';
import { useSession } from '../../state/session.js';
import { useUi, type ThemePreference } from '../../state/ui.js';

/**
 * Shared helpers of the profile module.
 *
 * Everything that profile screen and settings screen need in the same shape –
 * writing back to the account, the German wording of the connection state and
 * the little clipboard/URL utilities of the calendar subscription.
 */

export const APP_NAME = 'Initiative';
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? '0.1.0';
/**
 * Kurzer Commit-Hash dieses Frontend-Builds – von Vite eingesetzt.
 *
 * Die Abfrage mit `typeof` ist noetig, weil die Konstante nur beim Bauen
 * ersetzt wird; in Tests gibt es sie nicht.
 */
export const APP_COMMIT: string =
  typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';
export const REPO_URL: string =
  import.meta.env.VITE_REPO_URL ?? 'https://github.com/compufan/Initiative';

/** Same key the UI store uses – read here to detect a device without a choice. */
const THEME_KEY = 'initiative.theme';

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Patch the own account and keep the session store in sync. */
export async function patchMe(patch: Record<string, unknown>): Promise<SelfUserDto> {
  const user = await api.users.updateMe(patch);
  useSession.getState().setUser(user);
  return user;
}

/** Notification flags with the defaults filled in for older accounts. */
export function notificationSettings(user: SelfUserDto | null): UserSettings['notifications'] {
  return { ...DEFAULT_USER_SETTINGS.notifications, ...(user?.settings?.notifications ?? {}) };
}

export interface ConnectionInfo {
  label: string;
  description: string;
  tone: 'online' | 'pending' | 'offline';
}

export function connectionInfo(state: ConnectionState): ConnectionInfo {
  switch (state) {
    case 'online':
      return {
        label: 'Online',
        description: 'Neue Nachrichten kommen sofort an.',
        tone: 'online',
      };
    case 'connecting':
    case 'idle':
      return {
        label: 'Verbindet …',
        description: 'Die Verbindung wird gerade aufgebaut.',
        tone: 'pending',
      };
    default:
      return {
        label: 'Offline',
        description: 'Was du schreibst, wird gesendet, sobald du wieder Empfang hast.',
        tone: 'offline',
      };
  }
}

const monthYearFormat = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

export function memberSince(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Mitglied seit ${monthYearFormat.format(date)}`;
}

export function absoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  if (typeof window === 'undefined') return url;
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Clipboard with the legacy fallback iOS still needs outside a user gesture. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * A device that has never picked a look adopts the one stored with the account,
 * so a freshly installed PWA starts out exactly like the phone next to it.
 */
export function adoptAccountTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    return;
  }
  if (stored) return;
  const theme: ThemePreference | undefined = useSession.getState().user?.settings?.theme;
  if (theme && theme !== useUi.getState().theme) useUi.getState().setTheme(theme);
}
