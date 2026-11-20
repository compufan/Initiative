import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@initiative/shared';
import {
  STAENDE_MAX,
  fortsetzenBei,
  istSprachnachricht,
  naechsteGeschwindigkeit,
  naechsteSprachnachricht,
  standMerken,
  type Staende,
} from './warteschlange.js';

function nachricht(
  id: string,
  type: string,
  senderId = 'b',
  extra: Partial<MessageDto> = {},
): MessageDto {
  return {
    id,
    conversationId: 'c',
    senderId,
    type,
    body: null,
    attachments:
      type === 'audio'
        ? [
            {
              id: `a-${id}`,
              kind: 'audio',
              mime: 'audio/webm',
              size: 10,
              fileName: null,
              width: null,
              height: null,
              durationMs: 4000,
              waveform: null,
              previewDataUrl: null,
              url: `/api/v1/media/a-${id}`,
              status: 'ready',
              prioritaet: 'normal',
              ablage: 'lokal',
              createdAt: '2026-11-20T00:00:00Z',
            },
          ]
        : [],
    replyToId: null,
    replyTo: null,
    metadata: {},
    reactions: [],
    clientId: null,
    createdAt: '2026-11-20T00:00:00Z',
    editedAt: null,
    deletedAt: null,
    ...extra,
  } as MessageDto;
}

describe('Warteschlange der Sprachnachrichten', () => {
  const verlauf = [
    nachricht('1', 'audio'),
    nachricht('2', 'text'),
    nachricht('3', 'audio', 'ich'),
    nachricht('4', 'audio', 'b', { deletedAt: '2026-11-20T00:00:01Z' }),
    nachricht('5', 'audio'),
  ];

  it('spielt die nächste Sprachnachricht und überspringt Text und Gelöschtes', () => {
    expect(naechsteSprachnachricht(verlauf, '1')?.id).toBe('3');
    expect(naechsteSprachnachricht(verlauf, '3')?.id).toBe('5');
    expect(naechsteSprachnachricht(verlauf, '5')).toBeNull();
  });

  it('kann eigene überspringen', () => {
    expect(naechsteSprachnachricht(verlauf, '1', 'ich')?.id).toBe('5');
  });

  it('kennt eine unbekannte Nachricht nicht', () => {
    expect(naechsteSprachnachricht(verlauf, 'x')).toBeNull();
  });

  it('erkennt Sprachnachrichten', () => {
    expect(istSprachnachricht(verlauf[0])).toBe(true);
    expect(istSprachnachricht(verlauf[1])).toBe(false);
    expect(istSprachnachricht(verlauf[3])).toBe(false);
  });

  it('wechselt die Geschwindigkeit im Kreis', () => {
    expect(naechsteGeschwindigkeit(1)).toBe(1.5);
    expect(naechsteGeschwindigkeit(1.5)).toBe(2);
    expect(naechsteGeschwindigkeit(2)).toBe(1);
    expect(naechsteGeschwindigkeit(3)).toBe(1);
  });
});

describe('Fortschritt merken', () => {
  it('merkt die Stelle und setzt dort fort', () => {
    const staende = standMerken({}, 'a', 12.34, 60, 1);
    expect(fortsetzenBei(staende, 'a', 60)).toBe(12.3);
    expect(fortsetzenBei(staende, 'b', 60)).toBe(0);
  });

  it('vergisst Anfang und Ende', () => {
    let staende = standMerken({}, 'a', 30, 60, 1);
    staende = standMerken(staende, 'a', 59.5, 60, 2);
    expect(staende.a).toBeUndefined();
    staende = standMerken(staende, 'a', 0.4, 60, 3);
    expect(staende.a).toBeUndefined();
  });

  it('hält höchstens STAENDE_MAX Einträge und wirft die ältesten hinaus', () => {
    let staende: Staende = {};
    for (let i = 0; i < STAENDE_MAX + 5; i += 1) staende = standMerken(staende, `x${i}`, 5, 60, i);
    expect(Object.keys(staende)).toHaveLength(STAENDE_MAX);
    expect(staende.x0).toBeUndefined();
    expect(staende[`x${STAENDE_MAX + 4}`]).toBeDefined();
  });
});
