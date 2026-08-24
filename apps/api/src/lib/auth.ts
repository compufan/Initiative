import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import type { AppContext } from '../context.js';
import { unauthorized } from './errors.js';
import { verifyJwt } from './jwt.js';

export interface AuthUser {
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
    authenticate: preHandlerHookHandler;
  }
}

export function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header && /^bearer /i.test(header)) return header.slice(7).trim();
  const query = (request.query as { access_token?: string } | undefined)?.access_token;
  return query ?? null;
}

export function userIdFromToken(token: string, secret: string): string | null {
  const claims = verifyJwt(token, secret);
  if (!claims || claims.typ !== 'access') return null;
  return claims.sub;
}

const plugin: FastifyPluginAsync<{ ctx: AppContext }> = async (app, options) => {
  const secret = options.ctx.env.jwtSecret;

  app.decorateRequest('authUser', null);
  app.decorate('ctx', options.ctx);

  app.addHook('onRequest', async (request) => {
    const token = bearerFrom(request);
    if (!token) return;
    const userId = userIdFromToken(token, secret);
    if (userId) request.authUser = { id: userId };
  });

  app.decorate('authenticate', async (request) => {
    if (!request.authUser) throw unauthorized();
  });
};

export const authPlugin = fp(plugin, { name: 'initiative-auth' });

/** Use inside a route that runs behind `app.authenticate`. */
export function requireUserId(request: FastifyRequest): string {
  if (!request.authUser) throw unauthorized();
  return request.authUser.id;
}
