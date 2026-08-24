import webpush from 'web-push';
import type { PushPayload } from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { Env } from '../env.js';
import type { PushSubscriptionRow } from '../db/types.js';

/**
 * Web Push (VAPID). Works on Android/Chrome/Firefox out of the box and on iOS
 * 16.4+ once the PWA has been added to the home screen.
 */
export class PushService {
  private readonly env: Env;
  private readonly sql: Sql;
  readonly enabled: boolean;

  constructor(env: Env, sql: Sql) {
    this.env = env;
    this.sql = sql;
    this.enabled = env.pushEnabled;
    if (this.enabled) {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    }
  }

  get publicKey(): string | null {
    return this.env.VAPID_PUBLIC_KEY ?? null;
  }

  async sendToUsers(userIds: string[], payload: PushPayload): Promise<number> {
    if (!this.enabled || userIds.length === 0) return 0;
    const targets = [...new Set(userIds)];
    const subscriptions = await this.sql<PushSubscriptionRow[]>`
      select * from push_subscriptions where user_id = any(${targets})
    `;
    if (subscriptions.length === 0) return 0;

    const body = JSON.stringify(payload);
    const dead: string[] = [];
    let delivered = 0;

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
            { TTL: 60 * 60 * 12, urgency: 'high' },
          );
          delivered += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) dead.push(subscription.id);
        }
      }),
    );

    if (dead.length > 0) {
      await this.sql`delete from push_subscriptions where id = any(${dead})`;
    }
    return delivered;
  }

  /** Generate a fresh VAPID key pair (used by `pnpm keys:vapid`). */
  static generateKeys(): { publicKey: string; privateKey: string } {
    return webpush.generateVAPIDKeys();
  }
}
