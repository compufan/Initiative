import { envelope, type ServerEvent } from '@initiative/shared';
import { uuidv7 } from '@initiative/shared';
import type { RealtimeBus } from './bus.js';

export interface Socketish {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export interface Connection {
  id: string;
  userId: string;
  socket: Socketish;
  connectedAt: number;
  alive: boolean;
}

const OPEN = 1;

/**
 * Tracks the websockets attached to *this* instance. Cross-instance delivery is
 * handled by the bus: everything published there is fanned out locally here.
 */
export class RealtimeHub {
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly bus: RealtimeBus;
  private onPresenceChange: ((userId: string, online: boolean) => void) | null = null;

  constructor(bus: RealtimeBus) {
    this.bus = bus;
    this.bus.onMessage(({ userIds, event }) => this.deliverLocal(userIds, event));
  }

  setPresenceHandler(handler: (userId: string, online: boolean) => void): void {
    this.onPresenceChange = handler;
  }

  add(userId: string, socket: Socketish): Connection {
    const connection: Connection = { id: uuidv7(), userId, socket, connectedAt: Date.now(), alive: true };
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    const wasOffline = set.size === 0;
    set.add(connection);
    if (wasOffline) this.onPresenceChange?.(userId, true);
    return connection;
  }

  remove(connection: Connection): void {
    const set = this.byUser.get(connection.userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.byUser.delete(connection.userId);
      this.onPresenceChange?.(connection.userId, false);
    }
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  connectionCount(): number {
    let total = 0;
    for (const set of this.byUser.values()) total += set.size;
    return total;
  }

  /** Send to the given users on every instance. */
  async publish(userIds: string[], event: ServerEvent): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    await this.bus.publish({ userIds: unique, event });
  }

  /** Send only to sockets attached to this instance. */
  deliverLocal(userIds: string[], event: ServerEvent): void {
    const frame = JSON.stringify(envelope(event.type, event.payload));
    for (const userId of userIds) {
      const set = this.byUser.get(userId);
      if (!set) continue;
      for (const connection of set) {
        if (connection.socket.readyState !== OPEN) continue;
        try {
          connection.socket.send(frame);
        } catch {
          /* the close handler cleans up */
        }
      }
    }
  }

  sendTo(connection: Connection, event: ServerEvent): void {
    if (connection.socket.readyState !== OPEN) return;
    try {
      connection.socket.send(JSON.stringify(envelope(event.type, event.payload)));
    } catch {
      /* ignore */
    }
  }

  closeAll(): void {
    for (const set of this.byUser.values()) {
      for (const connection of set) {
        try {
          connection.socket.close(1001, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
    }
    this.byUser.clear();
  }
}
