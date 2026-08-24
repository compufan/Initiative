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
  kind: 'message' | 'event' | 'poll' | 'game' | 'system';
}
