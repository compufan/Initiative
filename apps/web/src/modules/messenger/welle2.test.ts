import { describe as gruppe, expect, it } from 'vitest';
import type { ConversationDto } from '@initiative/shared';
import { describe } from './SystemBubble.js';
import { ersterLink } from './LinkVorschauKarte.js';
import { erwaehnbare, erwaehnteIn } from './erwaehnungshilfe.js';
import { ortszeitFeld } from './GeplantSheet.js';

function chat(art: 'direct' | 'group', rolle: 'owner' | 'member'): ConversationDto {
  const mitglied = (id: string, role: string, name: string, nickname: string | null = null) => ({
    userId: id,
    role,
    joinedAt: '2026-01-01T00:00:00Z',
    nickname,
    lastReadMessageId: null,
    siehtAb: null,
    user: { id, username: name.toLowerCase(), displayName: name, avatarUrl: null, bio: null, accent: '#000', lastSeenAt: null, createdAt: '' },
  });
  return {
    id: 'c',
    type: art,
    members: [mitglied('ich', rolle, 'Ich'), mitglied('b', 'member', 'Bodo', 'Bodolino')],
    settings: { nurAdminsSenden: false, nurAdminsInfo: true, langsamerModus: 0 },
  } as unknown as ConversationDto;
}

gruppe('Systemzeilen der zweiten Welle', () => {
  it('Anheften und Selbstlöschen', () => {
    expect(describe('message.pinned', 'Anna', [], null)).toBe('Anna hat eine Nachricht angeheftet');
    expect(describe('conversation.selbstloeschen', 'Du', [], null, '7 Tage')).toBe(
      'Du hast selbstlöschende Nachrichten eingeschaltet – neue Nachrichten verschwinden nach 7 Tage',
    );
    expect(describe('conversation.selbstloeschen', 'Anna', [], null, 'aus')).toBe(
      'Anna hat selbstlöschende Nachrichten ausgeschaltet',
    );
  });
});

gruppe('Erwähnbare und Erwähnte', () => {
  it('„@alle“ nur für Admins in Gruppen', () => {
    expect(erwaehnbare(chat('group', 'owner'), 'ich').map((p) => p.userId)).toContain('alle');
    expect(erwaehnbare(chat('group', 'member'), 'ich').map((p) => p.userId)).not.toContain('alle');
    expect(erwaehnbare(chat('direct', 'owner'), 'ich').map((p) => p.userId)).not.toContain('alle');
  });
  it('Spitzname und Anzeigename werden beide erkannt', () => {
    const namen = erwaehnteIn({ mentions: ['b', 'fremd'] }, chat('group', 'member')).map((p) => p.name);
    expect(namen).toEqual(['Bodolino', 'Bodo']);
  });
});

gruppe('Kleinigkeiten', () => {
  it('der erste Link ohne Satzzeichen', () => {
    expect(ersterLink('siehe https://example.org/a.')).toBe('https://example.org/a');
    expect(ersterLink('kein Link')).toBeNull();
  });
  it('Ortszeit für datetime-local', () => {
    expect(ortszeitFeld(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05T07:03');
  });
});
