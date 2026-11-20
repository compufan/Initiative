import { describe, expect, it } from 'vitest';
import {
  CHAT_VOREINSTELLUNGEN,
  type ConversationDto,
  type ConversationMemberDto,
  type MemberRole,
} from '@initiative/shared';
import {
  darfInfoAendern,
  darfModerieren,
  darfSchreiben,
  langsamText,
  mitgliedAktionen,
} from './gruppenRechte.js';

function mitglied(userId: string, role: MemberRole): ConversationMemberDto {
  return {
    userId,
    role,
    joinedAt: '2026-01-01T00:00:00Z',
    nickname: null,
    lastReadMessageId: null,
    siehtAb: null,
    user: { id: userId, displayName: userId } as ConversationMemberDto['user'],
  };
}

function gruppe(teil: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'g',
    type: 'group',
    title: 'G',
    avatarUrl: null,
    createdBy: 'o',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    members: [
      mitglied('o', 'owner'),
      mitglied('a', 'admin'),
      mitglied('a2', 'admin'),
      mitglied('m', 'member'),
    ],
    lastMessage: null,
    unreadCount: 0,
    verdeckterVerlauf: false,
    mutedUntil: null,
    archived: false,
    ...CHAT_VOREINSTELLUNGEN,
    ...teil,
  };
}

describe('Rangordnung wie im Server', () => {
  const chat = gruppe();
  it('Admins nicht nach oben', () => {
    expect(mitgliedAktionen(chat, 'a', 'o')).toEqual({
      spitzname: false,
      zumAdmin: false,
      adminEntziehen: false,
      besitzUebergeben: false,
      entfernen: false,
    });
    expect(mitgliedAktionen(chat, 'a', 'a2').entfernen).toBe(false);
    expect(mitgliedAktionen(chat, 'a', 'm')).toMatchObject({
      zumAdmin: true,
      entfernen: true,
      spitzname: true,
      besitzUebergeben: false,
    });
  });
  it('der Besitzer darf alles mit allen unter ihm – und übergeben', () => {
    expect(mitgliedAktionen(chat, 'o', 'a')).toMatchObject({
      adminEntziehen: true,
      zumAdmin: false,
      entfernen: true,
      besitzUebergeben: true,
    });
  });
  it('Mitglieder moderieren nicht, setzen aber den eigenen Spitznamen', () => {
    expect(mitgliedAktionen(chat, 'm', 'a').entfernen).toBe(false);
    expect(mitgliedAktionen(chat, 'm', 'm').spitzname).toBe(true);
    expect(darfModerieren(chat, 'm')).toBe(false);
  });
  it('im Direktchat gibt es nichts zu moderieren', () => {
    const direkt = gruppe({ type: 'direct' });
    expect(darfModerieren(direkt, 'o')).toBe(false);
    expect(mitgliedAktionen(direkt, 'o', 'm').entfernen).toBe(false);
  });
});

describe('Schalter', () => {
  it('Gruppeninfo: Voreinstellung nur Admins', () => {
    expect(darfInfoAendern(gruppe(), 'm')).toBe(false);
    expect(darfInfoAendern(gruppe(), 'a')).toBe(true);
    const offen = gruppe({
      settings: { nurAdminsInfo: false, nurAdminsSenden: false, langsamerModus: 0 },
    });
    expect(darfInfoAendern(offen, 'm')).toBe(true);
  });
  it('nur Admins senden', () => {
    const zu = gruppe({
      settings: { nurAdminsInfo: true, nurAdminsSenden: true, langsamerModus: 0 },
    });
    expect(darfSchreiben(zu, 'm')).toBe(false);
    expect(darfSchreiben(zu, 'a')).toBe(true);
  });
  it('langsamer Modus lesbar', () => {
    expect(langsamText(0)).toBe('Aus');
    expect(langsamText(30)).toBe('30 s');
    expect(langsamText(300)).toBe('5 min');
    expect(langsamText(3600)).toBe('1 h');
  });
});
