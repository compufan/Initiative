import { describe, expect, it } from 'vitest';
import { einreihen, ueberlagern, type AktionsEintrag } from './aktionen.js';
import type { ChatMessage } from './chat.js';

function nachricht(id: string, body = 'hallo'): ChatMessage {
  return {
    id,
    conversationId: 'c',
    senderId: 'ich',
    type: 'text',
    body,
    attachments: [],
    replyToId: null,
    replyTo: null,
    metadata: {},
    reactions: [],
    clientId: null,
    createdAt: '2026-01-01T00:00:00Z',
    editedAt: null,
    deletedAt: null,
  };
}

describe('Aktionswarteschlange', () => {
  it('die letzte Absicht je Sache gilt', () => {
    let liste: AktionsEintrag[] = [];
    liste = einreihen(liste, { art: 'reaktion', messageId: 'm', conversationId: 'c', emoji: '❤️', setzen: true, ich: 'ich' });
    liste = einreihen(liste, { art: 'reaktion', messageId: 'm', conversationId: 'c', emoji: '❤️', setzen: false, ich: 'ich' });
    liste = einreihen(liste, { art: 'reaktion', messageId: 'm', conversationId: 'c', emoji: '👍', setzen: true, ich: 'ich' });
    expect(liste).toHaveLength(2);
    expect(liste.map((e) => e.schluessel)).toEqual(['reaktion:m:❤️', 'reaktion:m:👍']);
    expect(liste[0].aktion).toMatchObject({ setzen: false });
  });

  it('für alle löschen macht alles andere an der Nachricht überflüssig', () => {
    let liste: AktionsEintrag[] = [];
    liste = einreihen(liste, { art: 'bearbeiten', messageId: 'm', conversationId: 'c', body: 'neu', am: 'x' });
    liste = einreihen(liste, { art: 'stern', messageId: 'm', conversationId: 'c', setzen: true });
    liste = einreihen(liste, { art: 'bearbeiten', messageId: 'n', conversationId: 'c', body: 'b', am: 'x' });
    liste = einreihen(liste, { art: 'loeschen', messageId: 'm', conversationId: 'c', scope: 'all' });
    expect(liste.map((e) => e.schluessel)).toEqual(['bearbeiten:n', 'loeschen:m']);
  });

  it('überlagert Text, Löschen und Reaktionen – und lässt Unberührtes stehen', () => {
    const liste = [nachricht('a'), nachricht('b'), nachricht('c')];
    let aktionen: AktionsEintrag[] = [];
    expect(ueberlagern(liste, aktionen)).toBe(liste);
    aktionen = einreihen(aktionen, { art: 'bearbeiten', messageId: 'a', conversationId: 'c', body: 'neu', am: '2026-01-02T00:00:00Z' });
    aktionen = einreihen(aktionen, { art: 'loeschen', messageId: 'b', conversationId: 'c', scope: 'me' });
    aktionen = einreihen(aktionen, { art: 'reaktion', messageId: 'c', conversationId: 'c', emoji: '🎉', setzen: true, ich: 'ich' });
    const aus = ueberlagern(liste, aktionen);
    expect(aus.map((m) => m.id)).toEqual(['a', 'c']);
    expect(aus[0]).toMatchObject({ body: 'neu', editedAt: '2026-01-02T00:00:00Z' });
    expect(aus[1].reactions).toEqual([{ emoji: '🎉', userIds: ['ich'] }]);
  });

  it('eine entfernte Reaktion verschwindet, eine fremde bleibt', () => {
    const m = { ...nachricht('a'), reactions: [{ emoji: '❤️', userIds: ['ich', 'du'] }, { emoji: '👍', userIds: ['ich'] }] };
    let aktionen: AktionsEintrag[] = [];
    aktionen = einreihen(aktionen, { art: 'reaktion', messageId: 'a', conversationId: 'c', emoji: '❤️', setzen: false, ich: 'ich' });
    aktionen = einreihen(aktionen, { art: 'reaktion', messageId: 'a', conversationId: 'c', emoji: '👍', setzen: false, ich: 'ich' });
    expect(ueberlagern([m], aktionen)[0].reactions).toEqual([{ emoji: '❤️', userIds: ['du'] }]);
  });
});
