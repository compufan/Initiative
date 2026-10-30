/**
 * Was ein Client beim Senden in `metadata` mitgeben darf.
 *
 * Gegenstück zu `client_metadaten_pruefen` in `apps/api/src/modules/messages.rs`:
 * Was die Oberfläche wirklich schickt, muss durchgehen; was der Server selbst
 * setzt (Systemzeilen, Termin-Karten, Erinnerungen), darf es nicht.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from './constants.js';
import { sendMessageSchema } from './schemas/message.js';

const STICKER = '0192f0a8-6a4c-7c3e-8b1a-2f3e4d5c6b7a';

describe('sendMessageSchema', () => {
  it('nimmt an, was die Oberfläche sendet', () => {
    // Composer: Text ohne Zusatz; Sticker-Auswahl: nur die Kennung.
    expect(sendMessageSchema.safeParse({ body: 'Hallo', metadata: {} }).success).toBe(true);
    expect(
      sendMessageSchema.safeParse({ type: 'sticker', metadata: { stickerId: STICKER } }).success,
    ).toBe(true);
    expect(
      sendMessageSchema.safeParse({ body: 'x', clientId: '0192f0a8-6a4c-7c3e-8b1a-2f3e4d5c6b7a' })
        .success,
    ).toBe(true);
  });

  it('lehnt Schlüssel ab, die der Server selbst setzt', () => {
    for (const metadata of [
      { system: { kind: 'member.removed', actorId: STICKER } },
      { eventId: STICKER },
      { erinnerung: { nummer: 1 } },
      { pollId: STICKER },
      { gameSessionId: STICKER },
      { irgendwas: 1 },
    ]) {
      expect(
        sendMessageSchema.safeParse({ body: 'x', metadata }).success,
        JSON.stringify(metadata),
      ).toBe(false);
    }
  });

  it('begrenzt Größe und Wiederholungsschlüssel', () => {
    const gross = { module: { text: 'x'.repeat(LIMITS.messageMetadataMax) } };
    expect(sendMessageSchema.safeParse({ body: 'x', metadata: gross }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ body: 'x', clientId: 'x'.repeat(65) }).success).toBe(
      false,
    );
    expect(sendMessageSchema.safeParse({ body: 'x', clientId: 'karte:1' }).success).toBe(false);
  });
});
