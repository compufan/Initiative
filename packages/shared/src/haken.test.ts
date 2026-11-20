import { describe, expect, it } from 'vitest';
import { hakenFuer, type MitgliedStand } from './util/haken.js';

// UUIDv7-artig sortierbare Kennungen genügen für die Regel.
const m1 = '01900000-0000-7000-8000-000000000001';
const m2 = '01900000-0000-7000-8000-000000000002';
const m3 = '01900000-0000-7000-8000-000000000003';

const nachricht = { id: m2, senderId: 'ich', createdAt: '2026-01-02T10:00:00Z' };

function stand(userId: string, gelesen: string | null, zugestellt: string | null, siehtAb: string | null = null): MitgliedStand {
  return { userId, gelesen, zugestellt, siehtAb };
}

describe('Lesehäkchen', () => {
  it('wartet, solange die Nachricht nur lokal ist', () => {
    expect(hakenFuer({ ...nachricht, id: 'local:x' }, 'ich', [])).toBe('wartet');
    expect(hakenFuer({ ...nachricht, pending: true }, 'ich', [])).toBe('wartet');
  });

  it('Einzelchat: gesendet → zugestellt → gelesen', () => {
    expect(hakenFuer(nachricht, 'ich', [stand('ich', m3, m3), stand('du', m1, m1)])).toBe('gesendet');
    expect(hakenFuer(nachricht, 'ich', [stand('ich', m3, m3), stand('du', m1, m2)])).toBe('zugestellt');
    expect(hakenFuer(nachricht, 'ich', [stand('ich', m3, m3), stand('du', m3, m1)])).toBe('gelesen');
  });

  it('gelesen zählt als zugestellt', () => {
    expect(hakenFuer(nachricht, 'ich', [stand('du', m2, null)])).toBe('gelesen');
    expect(
      hakenFuer(nachricht, 'ich', [stand('du', m2, null)], { lesebestaetigungen: false }),
    ).toBe('zugestellt');
  });

  it('Gruppe: zugestellt erst, wenn bei allen; blau erst, wenn alle gelesen', () => {
    const staende = [stand('a', m2, m2), stand('b', null, m1)];
    expect(hakenFuer(nachricht, 'ich', staende)).toBe('gesendet');
    staende[1] = stand('b', null, m3);
    expect(hakenFuer(nachricht, 'ich', staende)).toBe('zugestellt');
    staende[1] = stand('b', m2, m3);
    expect(hakenFuer(nachricht, 'ich', staende)).toBe('gelesen');
  });

  it('wer die Nachricht nicht sehen darf, hält die Häkchen nicht auf', () => {
    // Später beigetreten: sieht ab danach.
    const staende = [stand('a', m2, m2), stand('neu', null, null, '2026-01-03T00:00:00Z')];
    expect(hakenFuer(nachricht, 'ich', staende)).toBe('gelesen');
  });

  it('allein im Chat: nur gesendet', () => {
    expect(hakenFuer(nachricht, 'ich', [stand('ich', m3, m3)])).toBe('gesendet');
  });
});
