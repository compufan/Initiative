import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  uuidv7,
} from '@initiative/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { UserRow } from '../../db/types.js';
import { conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { parseBody } from '../../lib/http.js';
import { hashPassword, randomToken, verifyPassword } from '../../lib/password.js';
import { requireUserId } from '../../lib/auth.js';
import {
  issueSession,
  pruneExpiredTokens,
  revokeAllSessions,
  revokeRefreshToken,
  rotateSession,
} from '../../services/auth.js';
import { getUserRow, toSelfUserDto } from '../../services/users.js';
import { defineModule } from '../types.js';

export default defineModule({
  key: 'auth',
  description: 'Registrierung, Login, Token-Rotation',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql, env } = ctx;

    app.post('/auth/register', async (request, reply) => {
      if (env.REGISTRATION_MODE === 'closed') {
        throw forbidden('Registrierung ist deaktiviert');
      }
      const input = parseBody(registerSchema, request);
      if (env.REGISTRATION_MODE === 'invite') {
        if (!input.inviteCode || !env.INVITE_CODES.includes(input.inviteCode)) {
          throw forbidden('Ungültiger Einladungscode');
        }
      }

      const existing = await sql<{ id: string }[]>`
        select id from users where username = ${input.username}
      `;
      if (existing.length > 0) throw conflict('Benutzername ist bereits vergeben');

      const rows = await sql<UserRow[]>`
        insert into users ${sql({
          id: uuidv7(),
          username: input.username,
          displayName: input.displayName,
          passwordHash: await hashPassword(input.password),
          calendarToken: randomToken(24),
        })}
        returning *
      `;
      const user = rows[0]!;
      reply.status(201);
      return issueSession(sql, env, user, request.headers['user-agent']);
    });

    app.post('/auth/login', async (request) => {
      const input = parseBody(loginSchema, request);
      const rows = await sql<UserRow[]>`select * from users where username = ${input.username}`;
      const user = rows[0];
      // Always run a hash comparison so timing does not reveal existing accounts.
      const ok = user
        ? await verifyPassword(input.password, user.passwordHash)
        : await verifyPassword(input.password, 'scrypt$AAAA$AAAA');
      if (!user || !ok) throw unauthorized('Benutzername oder Passwort ist falsch');

      void pruneExpiredTokens(sql).catch(() => {});
      await sql`update users set last_seen_at = now() where id = ${user.id}`;
      return issueSession(sql, env, user, request.headers['user-agent']);
    });

    app.post('/auth/refresh', async (request) => {
      const input = parseBody(refreshSchema, request);
      return rotateSession(sql, env, input.refreshToken, request.headers['user-agent']);
    });

    app.post('/auth/logout', async (request, reply) => {
      const input = parseBody(refreshSchema.partial(), request);
      if (input.refreshToken) await revokeRefreshToken(sql, input.refreshToken);
      reply.status(204);
      return null;
    });

    app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
      const user = await getUserRow(sql, requireUserId(request));
      if (!user) throw unauthorized();
      return toSelfUserDto(user);
    });

    app.post('/auth/password', { preHandler: app.authenticate }, async (request, reply) => {
      const input = parseBody(changePasswordSchema, request);
      const userId = requireUserId(request);
      const user = await getUserRow(sql, userId);
      if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
        throw unauthorized('Aktuelles Passwort ist falsch');
      }
      await sql`
        update users set password_hash = ${await hashPassword(input.newPassword)}, updated_at = now()
        where id = ${userId}
      `;
      await revokeAllSessions(sql, userId);
      reply.status(204);
      return null;
    });

    app.post('/auth/calendar-token/rotate', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const token = randomToken(24);
      await sql`update users set calendar_token = ${token} where id = ${userId}`;
      return { calendarToken: token };
    });
  },
});
