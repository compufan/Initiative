import { z } from 'zod';

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(10).max(300),
    auth: z.string().min(4).max(300),
  }),
  userAgent: z.string().max(300).optional(),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export interface PushPublicKeyDto {
  publicKey: string | null;
  enabled: boolean;
}

/** Payload delivered to the service worker. Keep it small (<4 KB). */
export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url: string;
  conversationId?: string;
  messageId?: string;
  /** `message-leise`: „Ohne Ton senden“ – zeigen, aber ohne Ton und Vibration. */
  /**
   * `anruf`: „Anruf von …“ (klingelt, bleibt stehen); `anruf-ende`: anderswo
   * angenommen/abgelehnt (ersetzt und verschwindet); `anruf-verpasst`.
   */
  kind:
    | 'message'
    | 'message-leise'
    | 'event'
    | 'poll'
    | 'game'
    | 'system'
    | 'anruf'
    | 'anruf-ende'
    | 'anruf-verpasst';
}
