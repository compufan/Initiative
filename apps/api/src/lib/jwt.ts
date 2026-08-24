import { createHmac, timingSafeEqual } from 'node:crypto';

/** Minimal HS256 JWT implementation – no runtime dependency, no algorithm confusion. */

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(
  payload: Omit<JwtClaims, 'iat' | 'exp'> & { [key: string]: unknown },
  secret: string,
  ttlSeconds: number,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = { ...payload, sub: String(payload.sub), iat: issuedAt, exp: issuedAt + ttlSeconds };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    return claims;
  } catch {
    return null;
  }
}
