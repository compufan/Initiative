import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConversationDto, MessageDto } from '@initiative/shared';

/**
 * Offline layer.
 *
 * Chats and the most recent messages are cached so the app opens instantly (and
 * readable) without a network, while unsent messages wait in an outbox that is
 * flushed as soon as the connection is back – including media captured offline.
 */

export interface OutboxAttachment {
  kind: 'image' | 'video' | 'audio' | 'file' | 'sticker';
  mime: string;
  fileName: string;
  blob: Blob;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
  previewDataUrl?: string;
}

export interface OutboxEntry {
  clientId: string;
  conversationId: string;
  type: MessageDto['type'];
  body: string | null;
  replyToId: string | null;
  metadata: MessageDto['metadata'];
  attachmentIds: string[];
  pendingAttachments: OutboxAttachment[];
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

/**
 * Ein liegengebliebener Entwurf aus dem Fotoeditor.
 *
 * Was hier NICHT drinsteht, ist das Bild. Ein Foto von zwölf Megapunkten
 * wäre ein Vielfaches von allem anderen in dieser Datenbank, und es liegt ja
 * schon irgendwo – als Anhang auf dem Server oder als Datei im Gerät. Der
 * Entwurf ist die ANWEISUNG dazu, in genau der Form, in der sie auch
 * verschickt wird (`docNachRoh` in `rezept.ts`).
 *
 * Der Schlüssel ist deshalb eine Kennung des BILDES und nicht des Editors:
 * Wer dasselbe Foto wieder aufmacht, soll seinen Entwurf wiederfinden, egal
 * über welchen Weg er hereinkommt.
 */
export interface Bildentwurf {
  /** Kennung des Bildes – siehe `bildKennung` in `entwurf.ts`. */
  id: string;
  /** Das Dokument als reines JSON. */
  doc: unknown;
  /** Die Masse, zu denen es gehört. Passen sie nicht, gilt der Entwurf nicht. */
  breite: number;
  hoehe: number;
  /** Wann zuletzt geschrieben, in Millisekunden. */
  stand: number;
  name: string | null;
}

interface InitiativeDB extends DBSchema {
  conversations: { key: string; value: ConversationDto };
  entwuerfe: { key: string; value: Bildentwurf };
  messages: {
    key: string;
    value: MessageDto;
    indexes: { 'by-conversation': string };
  };
  outbox: { key: string; value: OutboxEntry; indexes: { 'by-conversation': string } };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<InitiativeDB>> | null = null;

function getDb(): Promise<IDBPDatabase<InitiativeDB>> {
  if (!dbPromise) {
    /*
     * Fassung 2 bringt `entwuerfe`.
     *
     * `upgrade` läuft bei JEDER Erhöhung und legt nur an, was fehlt – die
     * vorhandenen Abfragen bleiben unangetastet. Wer die Zahl vergisst und
     * nur den Aufruf hinzufügt, bekommt einen Speicher, den es in schon
     * geöffneten Datenbanken nie geben wird.
     */
    dbPromise = openDB<InitiativeDB>('initiative', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('by-conversation', 'conversationId');
        }
        if (!db.objectStoreNames.contains('outbox')) {
          const store = db.createObjectStore('outbox', { keyPath: 'clientId' });
          store.createIndex('by-conversation', 'conversationId');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('entwuerfe')) {
          db.createObjectStore('entwuerfe', { keyPath: 'id' });
        }
      },
    }).catch((error) => {
      // Safari private mode and locked-down browsers: degrade to online-only.
      console.warn('IndexedDB unavailable, running without offline cache', error);
      throw error;
    });
  }
  return dbPromise;
}

async function safe<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

export async function cacheConversations(conversations: ConversationDto[]): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    const tx = db.transaction('conversations', 'readwrite');
    await Promise.all(conversations.map((conversation) => tx.store.put(conversation)));
    await tx.done;
  }, undefined);
}

export async function readCachedConversations(): Promise<ConversationDto[]> {
  return safe(async () => {
    const db = await getDb();
    const items = await db.getAll('conversations');
    return items.sort(
      (a, b) =>
        new Date(b.lastMessage?.createdAt ?? b.updatedAt).getTime() -
        new Date(a.lastMessage?.createdAt ?? a.updatedAt).getTime(),
    );
  }, []);
}

export async function removeCachedConversation(id: string): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.delete('conversations', id);
    const keys = await db.getAllKeysFromIndex('messages', 'by-conversation', id);
    const tx = db.transaction('messages', 'readwrite');
    await Promise.all(keys.map((key) => tx.store.delete(key)));
    await tx.done;
  }, undefined);
}

const MESSAGE_CACHE_PER_CHAT = 200;

export async function cacheMessages(messages: MessageDto[]): Promise<void> {
  if (messages.length === 0) return;
  await safe(async () => {
    const db = await getDb();
    const tx = db.transaction('messages', 'readwrite');
    await Promise.all(messages.map((message) => tx.store.put(message)));
    await tx.done;
  }, undefined);
}

export async function readCachedMessages(conversationId: string): Promise<MessageDto[]> {
  return safe(async () => {
    const db = await getDb();
    const items = await db.getAllFromIndex('messages', 'by-conversation', conversationId);
    return items.sort((a, b) => a.id.localeCompare(b.id)).slice(-MESSAGE_CACHE_PER_CHAT);
  }, []);
}

export async function dropCachedMessage(id: string): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.delete('messages', id);
  }, undefined);
}

export async function trimMessageCache(conversationId: string): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    const keys = await db.getAllKeysFromIndex('messages', 'by-conversation', conversationId);
    if (keys.length <= MESSAGE_CACHE_PER_CHAT) return;
    const stale = keys.sort().slice(0, keys.length - MESSAGE_CACHE_PER_CHAT);
    const tx = db.transaction('messages', 'readwrite');
    await Promise.all(stale.map((key) => tx.store.delete(key)));
    await tx.done;
  }, undefined);
}

export async function enqueueOutbox(entry: OutboxEntry): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.put('outbox', entry);
  }, undefined);
}

export async function readOutbox(conversationId?: string): Promise<OutboxEntry[]> {
  return safe(async () => {
    const db = await getDb();
    const items = conversationId
      ? await db.getAllFromIndex('outbox', 'by-conversation', conversationId)
      : await db.getAll('outbox');
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }, []);
}

export async function updateOutbox(entry: OutboxEntry): Promise<void> {
  await enqueueOutbox(entry);
}

export async function removeOutbox(clientId: string): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.delete('outbox', clientId);
  }, undefined);
}

export async function readMeta<T>(key: string): Promise<T | null> {
  return safe(async () => {
    const db = await getDb();
    return ((await db.get('meta', key)) as T) ?? null;
  }, null);
}

export async function writeMeta(key: string, value: unknown): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.put('meta', value, key);
  }, undefined);
}

/** Called on logout so no chat data survives for the next account. */
export async function clearOfflineData(): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await Promise.all([
      db.clear('conversations'),
      db.clear('messages'),
      db.clear('outbox'),
      db.clear('meta'),
      // Auch die Entwürfe: Sie tragen zwar kein Bild, aber sie verraten, was
      // jemand an einem Bild gemacht hat – wo ein Balken lag, was
      // weggeschnitten wurde.
      db.clear('entwuerfe'),
    ]);
  }, undefined);
}

/* ---------- Entwürfe aus dem Fotoeditor ---------- */

/**
 * Wieviele Entwürfe höchstens liegenbleiben, und wie lange.
 *
 * Beides, weil beides allein danebengeht: Eine reine Anzahl hielte einen
 * Entwurf von vor zwei Jahren, ein reines Alter liesse hundert Entwürfe eines
 * geschäftigen Tages nebeneinander stehen. Ein Entwurf mit Netzmaske ist
 * einige Dutzend Kilobyte gross.
 */
const ENTWUERFE_MAX = 20;
const ENTWURF_TAGE = 30;

export async function entwurfLesen(id: string): Promise<Bildentwurf | null> {
  return safe(async () => {
    const db = await getDb();
    return (await db.get('entwuerfe', id)) ?? null;
  }, null);
}

export async function entwurfSchreiben(entwurf: Bildentwurf): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.put('entwuerfe', entwurf);
    // Aufräumen im selben Zug: Ein eigener Zeitgeber dafür wäre ein Dienst,
    // der läuft, wenn niemand ihn braucht.
    const alle = await db.getAll('entwuerfe');
    const grenze = Date.now() - ENTWURF_TAGE * 24 * 60 * 60 * 1000;
    const weg = alle
      .filter((e) => e.stand < grenze)
      .concat(
        alle
          .filter((e) => e.stand >= grenze)
          .sort((a, b) => b.stand - a.stand)
          .slice(ENTWUERFE_MAX),
      );
    await Promise.all(weg.map((e) => db.delete('entwuerfe', e.id)));
  }, undefined);
}

export async function entwurfLoeschen(id: string): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    await db.delete('entwuerfe', id);
  }, undefined);
}
