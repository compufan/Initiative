import { pushSubscriptionSchema, uuidv7 } from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { parseBody } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { defineModule } from '../types.js';

export default defineModule({
  key: 'push',
  description: 'Web-Push-Abonnements für Benachrichtigungen',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;

    app.get('/push/public-key', async () => ({
      publicKey: ctx.push.publicKey,
      enabled: ctx.push.enabled,
    }));

    app.post('/push/subscriptions', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(pushSubscriptionSchema, request);

      await sql`
        insert into push_subscriptions ${sql({
          id: uuidv7(),
          userId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? request.headers['user-agent']?.slice(0, 300) ?? null,
        })}
        on conflict (endpoint) do update
        set user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            failure_count = 0
      `;
      reply.status(201);
      return { ok: true };
    });

    app.delete('/push/subscriptions', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { endpoint } = parseBody(z.object({ endpoint: z.string().url() }), request);
      await sql`delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`;
      reply.status(204);
      return null;
    });

    app.post('/push/test', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const delivered = await ctx.push.sendToUsers([userId], {
        title: 'Initiative',
        body: 'Benachrichtigungen funktionieren 🎉',
        url: '/',
        kind: 'system',
      });
      return { delivered };
    });
  },
});
