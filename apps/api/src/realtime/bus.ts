import type { ServerEvent } from '@initiative/shared';
import { createClient, type Sql } from '../db/client.js';
import type { Env } from '../env.js';

export interface BusMessage {
  /** Recipients; the hub drops ids that are not connected to this instance. */
  userIds: string[];
  event: ServerEvent;
}

export interface RealtimeBus {
  readonly kind: 'memory' | 'postgres';
  publish(message: BusMessage): Promise<void>;
  onMessage(handler: (message: BusMessage) => void): void;
  close(): Promise<void>;
}

const CHANNEL = 'initiative_realtime';
/** Postgres NOTIFY payloads are limited to 8000 bytes. */
const MAX_NOTIFY_BYTES = 7000;

export class MemoryBus implements RealtimeBus {
  readonly kind = 'memory' as const;
  private handlers: ((message: BusMessage) => void)[] = [];

  async publish(message: BusMessage): Promise<void> {
    for (const handler of this.handlers) handler(message);
  }

  onMessage(handler: (message: BusMessage) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers = [];
  }
}

/**
 * Fan-out across instances via Postgres LISTEN/NOTIFY, so the API can scale
 * horizontally on Fly.io/Koyeb without an extra Redis.
 */
export class PostgresBus implements RealtimeBus {
  readonly kind = 'postgres' as const;
  private readonly listener: Sql;
  private readonly publisher: Sql;
  private handlers: ((message: BusMessage) => void)[] = [];
  private ready: Promise<unknown> | null = null;

  constructor(env: Env, publisher: Sql) {
    this.publisher = publisher;
    this.listener = createClient(env.DATABASE_URL, 2);
  }

  private ensureListening(): Promise<unknown> {
    if (!this.ready) {
      this.ready = this.listener.listen(CHANNEL, (payload) => {
        try {
          const message = JSON.parse(payload) as BusMessage;
          if (Array.isArray(message.userIds) && message.event) {
            for (const handler of this.handlers) handler(message);
          }
        } catch {
          /* ignore malformed payloads */
        }
      });
    }
    return this.ready;
  }

  async publish(message: BusMessage): Promise<void> {
    if (message.userIds.length === 0) return;
    let payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) {
      // Too large for NOTIFY – tell clients to refetch instead of dropping it.
      const conversationId = (message.event.payload as { conversationId?: string } | undefined)
        ?.conversationId;
      payload = JSON.stringify({
        userIds: message.userIds,
        event: {
          type: 'sync.hint',
          payload: { scope: message.event.type, ...(conversationId ? { conversationId } : {}) },
        },
      } satisfies BusMessage);
    }
    await this.publisher.notify(CHANNEL, payload);
  }

  onMessage(handler: (message: BusMessage) => void): void {
    this.handlers.push(handler);
    void this.ensureListening();
  }

  async close(): Promise<void> {
    this.handlers = [];
    await this.listener.end({ timeout: 3 }).catch(() => {});
  }
}

export function createBus(env: Env, sql: Sql): RealtimeBus {
  return env.REALTIME_BUS === 'memory' ? new MemoryBus() : new PostgresBus(env, sql);
}
