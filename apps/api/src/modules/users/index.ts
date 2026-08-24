import { updateProfileSchema, userSearchSchema, uuidSchema } from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { UserRow } from '../../db/types.js';
import { jsonb } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { getUserRow, mergeSettings, toSelfUserDto, toUserDto } from '../../services/users.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });

export default defineModule({
  key: 'users',
  description: 'Profile, Suche und Einstellungen',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;

    app.get('/users', { preHandler: app.authenticate }, async (request) => {
      const { q, limit } = parseQuery(userSearchSchema, request);
      const viewerId = requireUserId(request);
      const pattern = `%${q.toLowerCase()}%`;
      const rows = await sql<UserRow[]>`
        select * from users
        where id <> ${viewerId}
          and (lower(username) like ${pattern} or lower(display_name) like ${pattern})
        order by
          case when lower(username) = ${q.toLowerCase()} then 0 else 1 end,
          display_name asc
        limit ${limit ?? 20}
      `;
      return { items: rows.map(toUserDto) };
    });

    app.get('/users/:id', { preHandler: app.authenticate }, async (request) => {
      const { id } = parseParams(idParams, request);
      const user = await getUserRow(sql, id);
      if (!user) throw notFound('Benutzer nicht gefunden');
      return toUserDto(user);
    });

    app.patch('/users/me', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const input = parseBody(updateProfileSchema, request);
      const current = await getUserRow(sql, userId);
      if (!current) throw notFound('Benutzer nicht gefunden');

      const patch: Record<string, unknown> = {};
      if (input.displayName !== undefined) patch.displayName = input.displayName;
      if (input.bio !== undefined) patch.bio = input.bio;
      if (input.avatarAttachmentId !== undefined) patch.avatarAttachmentId = input.avatarAttachmentId;
      if (input.settings !== undefined) {
        const merged = mergeSettings(current.settings);
        patch.settings = jsonb(sql, {
          ...merged,
          ...input.settings,
          notifications: { ...merged.notifications, ...(input.settings.notifications ?? {}) },
          modules: { ...merged.modules, ...(input.settings.modules ?? {}) },
        });
      }

      if (Object.keys(patch).length === 0) return toSelfUserDto(current);

      patch.updatedAt = new Date();
      const rows = await sql<UserRow[]>`
        update users set ${sql(patch)} where id = ${userId} returning *
      `;
      const updated = rows[0]!;

      // Everyone who shares a chat with this user sees the new profile instantly.
      const contacts = await sql<{ userId: string }[]>`
        select distinct other.user_id
        from conversation_members mine
        join conversation_members other on other.conversation_id = mine.conversation_id
        where mine.user_id = ${userId}
      `;
      await ctx.hub.publish(
        contacts.map((row) => row.userId),
        { type: 'user.updated', payload: { user: toUserDto(updated) } },
      );

      return toSelfUserDto(updated);
    });
  },
});
