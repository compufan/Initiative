import { describe as gruppe, expect, it } from 'vitest';
import { describe } from './SystemBubble.js';

gruppe('Systemzeilen der Gruppenverwaltung', () => {
  it('nennen, was sich geändert hat', () => {
    expect(describe('conversation.renamed', 'Anna', [], null, 'Grillrunde')).toBe(
      'Anna hat die Gruppe in „Grillrunde“ umbenannt',
    );
    expect(describe('member.promoted', 'Du', ['Bodo'], null)).toBe(
      'Du hast Bodo zum Admin gemacht',
    );
    expect(describe('owner.transferred', 'Anna', ['Cleo'], null)).toBe(
      'Anna hat die Gruppe an Cleo übergeben',
    );
    expect(describe('conversation.settings', 'Anna', [], null, 'nur Admins dürfen schreiben')).toBe(
      'Anna hat die Gruppeneinstellungen geändert: nur Admins dürfen schreiben',
    );
    expect(describe('member.joined', 'Du', [], null)).toBe(
      'Du bist über einen Einladungslink beigetreten',
    );
  });
});

gruppe('Systemzeilen der Anrufe', () => {
  it('sagen dem Anrufer „nicht angenommen“ und dem Angerufenen „verpasst“', () => {
    expect(describe('anruf', 'Anna', ['Du'], null, 'Verpasster Anruf')).toBe('Verpasster Anruf');
    expect(describe('anruf', 'Du', ['Bodo'], null, 'Verpasster Anruf')).toBe(
      'Anruf nicht angenommen',
    );
    expect(describe('anruf', 'Du', ['Bodo'], null, 'Verpasster Videoanruf')).toBe(
      'Videoanruf nicht angenommen',
    );
    expect(describe('anruf', 'Du', ['Bodo'], null, 'Anruf, 3:12')).toBe('Anruf, 3:12');
  });
});
