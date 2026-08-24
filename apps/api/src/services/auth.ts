import { createHash } from 'node:crypto';
import { uuidv7, type AuthSession, type AuthTokens } from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { UserRow } from '../db/types.js';
import type { Env } from '../env.js';
import { signJwt } from '../lib/jwt.js';
import { randomToken } from '../lib/password.js';
import { unauthorized } from '../lib/errors.js';
import { toSelfUserDto } from './users.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueSession(
  sql: Sql,
  env: Env,
  user: UserRow,
  userAgent?: string | null,
): Promise<AuthSession> {
  const tokens = await issueTokens(sql, env, user, userAgent);
  return { ...tokens, user: toSelfUserDto(user) };
}

export async function issueTokens(
  sql: Sql,
  env: Env,
  user: UserRow,
  userAgent?: string | null,
): Promise<AuthTokens> {
  const accessToken = signJwt({ sub: user.id, typ: 'access' }, env.jwtSecret, env.ACCESS_TOKEN_TTL);
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await sql`
    insert into refresh_tokens ${sql({
      id: uuidv7(),
      userId: user.id,
      tokenHash: sha256(refreshToken),
      userAgent: userAgent?.slice(0, 300) ?? null,
      expiresAt,
    })}
  `;

  return { accessToken, refreshToken, expiresIn: env.ACCESS_TOKEN_TTL };
}

/** Rotate a refresh token: the presented token is revoked and a new pair issued. */
export async function rotateSession(
  sql: Sql,
  env: Env,
  refreshToken: string,
  userAgent?: string | null,
): Promise<AuthSession> {
  const hash = sha256(refreshToken);
  const rows = await sql<{ id: string; userId: string; expiresAt: Date; revokedAt: Date | null }[]>`
    select id, user_id, expires_at, revoked_at from refresh_tokens where token_hash = ${hash}
  `;
  const token = rows[0];
  if (!token || token.revokedAt || token.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Sitzung abgelaufen, bitte neu anmelden');
  }

  await sql`update refresh_tokens set revoked_at = now() where id = ${token.id}`;

  const users = await sql<UserRow[]>`select * from users where id = ${token.userId}`;
  const user = users[0];
  if (!user) throw unauthorized();

  return issueSession(sql, env, user, userAgent);
}

export async function revokeRefreshToken(sql: Sql, refreshToken: string): Promise<void> {
  await sql`update refresh_tokens set revoked_at = now() where token_hash = ${sha256(refreshToken)}`;
}

export async function revokeAllSessions(sql: Sql, userId: string): Promise<void> {
  await sql`update refresh_tokens set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
}

/** Housekeeping – called opportunistically on login. */
export async function pruneExpiredTokens(sql: Sql): Promise<void> {
  await sql`delete from refresh_tokens where expires_at < now() - interval '7 days'`;
}
