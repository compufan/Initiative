import { describe, expect, it } from 'vitest';
import {
  OUTBOX_BLOB_MAX,
  ausDemSpeicher,
  dateiHinterlegen,
  zumSpeichern,
  type OutboxEntry,
} from './db.js';

/**
 * Grosse Dateien wandern nicht in IndexedDB (siehe `OUTBOX_BLOB_MAX`). Statt
 * echter Gigabytes genügt ein Blob, der so tut: `size` ist alles, was die
 * Entscheidung ansieht.
 */
function grosserBlob(): Blob {
  const blob = new Blob(['x']);
  Object.defineProperty(blob, 'size', { value: OUTBOX_BLOB_MAX + 1 });
  return blob;
}

function eintrag(blob: Blob): OutboxEntry {
  return {
    clientId: `c-${Math.random()}`,
    conversationId: 'k',
    type: 'video',
    body: null,
    replyToId: null,
    metadata: {},
    attachmentIds: [],
    pendingAttachments: [{ kind: 'video', mime: 'video/mp4', fileName: 'film.mp4', blob }],
    createdAt: 0,
    attempts: 0,
    lastError: null,
  };
}

describe('Outbox mit grossen Dateien', () => {
  it('legt kleine Blobs unverändert ab', () => {
    const klein = new Blob(['abc']);
    const e = eintrag(klein);
    expect(zumSpeichern(e).pendingAttachments[0].blob).toBe(klein);
  });

  it('ersetzt grosse Blobs durch einen Verweis und holt sie im selben Tab zurück', () => {
    const gross = grosserBlob();
    const e = eintrag(gross);
    const gespeichert = zumSpeichern(e);
    expect(gespeichert.pendingAttachments[0].blob.size).toBe(0);
    expect(gespeichert.pendingAttachments[0].grosseDatei?.groesse).toBe(OUTBOX_BLOB_MAX + 1);
    const zurueck = ausDemSpeicher(gespeichert);
    expect(zurueck.pendingAttachments[0].blob).toBe(gross);
    expect(zurueck.pendingAttachments[0].blobFehlt).toBe(false);
  });

  it('meldet nach einem Neustart, dass die Datei fehlt – bis sie neu hinterlegt ist', () => {
    const e = eintrag(grosserBlob());
    const gespeichert = zumSpeichern(e);
    // „Neustart": ein anderer Eintrag mit derselben Form, aber ohne Verweis im Speicher.
    const fremd = { ...gespeichert, clientId: 'nach-neustart' };
    expect(ausDemSpeicher(fremd).pendingAttachments[0].blobFehlt).toBe(true);
    const neu = grosserBlob();
    dateiHinterlegen('nach-neustart', 0, neu);
    expect(ausDemSpeicher(fremd).pendingAttachments[0].blob).toBe(neu);
    // Ein zweites Speichern behält den Verweis, statt den leeren Blob zu merken.
    const wieder = zumSpeichern(ausDemSpeicher(fremd));
    expect(wieder.pendingAttachments[0].grosseDatei?.groesse).toBe(OUTBOX_BLOB_MAX + 1);
  });
});
