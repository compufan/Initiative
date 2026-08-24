import { describe, expect, it } from 'vitest';
import type { SelfUserDto } from '@initiative/shared';
import { connectionInfo, errorMessage, memberSince, notificationSettings } from './helpers.js';

function user(overrides: Partial<SelfUserDto> = {}): SelfUserDto {
  return {
    id: '11111111-1111-7111-8111-111111111111',
    username: 'mia',
    displayName: 'Mia',
    avatarUrl: null,
    bio: null,
    accent: '#6d7cff',
    lastSeenAt: null,
    createdAt: '2026-03-14T10:00:00.000Z',
    calendarToken: 'token',
    settings: {
      theme: 'system',
      locale: 'de',
      notifications: { push: true, sound: true, previews: true },
      modules: {},
    },
    ...overrides,
  };
}

describe('connectionInfo', () => {
  it('names the three states a person can see', () => {
    expect(connectionInfo('online').label).toBe('Online');
    expect(connectionInfo('connecting').label).toBe('Verbindet …');
    expect(connectionInfo('idle').label).toBe('Verbindet …');
    expect(connectionInfo('offline').label).toBe('Offline');
  });

  it('keeps tone and label in sync', () => {
    expect(connectionInfo('online').tone).toBe('online');
    expect(connectionInfo('connecting').tone).toBe('pending');
    expect(connectionInfo('offline').tone).toBe('offline');
  });
});

describe('memberSince', () => {
  it('formats month and year in German', () => {
    expect(memberSince('2026-03-14T10:00:00.000Z')).toBe('Mitglied seit März 2026');
  });

  it('stays quiet without a usable date', () => {
    expect(memberSince(null)).toBeNull();
    expect(memberSince('keine Zeit')).toBeNull();
  });
});

describe('notificationSettings', () => {
  it('falls back to the defaults for an unknown user', () => {
    expect(notificationSettings(null)).toEqual({ push: true, sound: true, previews: true });
  });

  it('keeps what the account stores', () => {
    const settings = notificationSettings(
      user({
        settings: {
          theme: 'dark',
          locale: 'de',
          notifications: { push: false, sound: true, previews: false },
          modules: {},
        },
      }),
    );
    expect(settings).toEqual({ push: false, sound: true, previews: false });
  });
});

describe('errorMessage', () => {
  it('prefers the message of a real error', () => {
    expect(errorMessage(new Error('Netz weg'), 'Ersatz')).toBe('Netz weg');
  });

  it('uses the fallback for anything else', () => {
    expect(errorMessage({ nope: true }, 'Ersatz')).toBe('Ersatz');
    expect(errorMessage(new Error(''), 'Ersatz')).toBe('Ersatz');
  });
});
