import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { API_PREFIX, LIMITS } from '@initiative/shared';
import type { AppContext } from './context.js';
import { AppError, validationError } from './lib/errors.js';
import { authPlugin } from './lib/auth.js';
import { registerRealtime } from './realtime/ws.js';
import { modules } from './modules/registry.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.env.LOG_LEVEL,
      ...(ctx.env.isProduction
        ? {}
        : { transport: undefined, redact: ['req.headers.authorization'] }),
    },
    trustProxy: ctx.env.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: !ctx.env.isProduction ? false : true,
  });

  const allowedOrigins = new Set(
    [...ctx.env.CORS_ORIGINS, ctx.env.PUBLIC_APP_URL].filter(Boolean).map((o) => o.replace(/\/$/, '')),
  );

  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalised = origin.replace(/\/$/, '');
      if (allowedOrigins.has('*') || allowedOrigins.has(normalised)) return callback(null, true);
      // Local development hosts (Vite, LAN testing on a phone) are always allowed.
      if (!ctx.env.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.)/.test(normalised)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  });

  await app.register(multipart, {
    limits: {
      fileSize: Math.max(...Object.values(LIMITS.maxUploadBytes)),
      files: 1,
    },
  });

  await app.register(websocket, {
    options: { maxPayload: 256 * 1024 },
  });

  await app.register(authPlugin, { ctx });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof ZodError) {
      const wrapped = validationError(error);
      reply
        .status(wrapped.statusCode)
        .send({ error: { code: wrapped.code, message: wrapped.message, details: wrapped.details } });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');
    reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'internal_error' : 'request_failed',
        message:
          statusCode >= 500
            ? 'Interner Serverfehler'
            : ((error as Error).message ?? 'Anfrage fehlgeschlagen'),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `Kein Endpunkt für ${request.method} ${request.url}` },
    });
  });

  app.get('/', async () => ({
    name: 'Initiative API',
    version: 1,
    modules: modules.map((module) => module.key),
    docs: 'https://github.com/compufan/Initiative/blob/main/docs/API.md',
  }));

  app.get('/healthz', async (_request, reply) => {
    try {
      await ctx.sql`select 1 as ok`;
      return {
        status: 'ok',
        storage: ctx.storage.kind,
        bus: ctx.bus.kind,
        push: ctx.push.enabled,
        connections: ctx.hub.connectionCount(),
      };
    } catch (error) {
      reply.status(503);
      return { status: 'degraded', error: (error as Error).message };
    }
  });

  // Feature modules own everything below /api/v1.
  await app.register(
    async (scope) => {
      for (const module of modules) {
        await module.register(scope, ctx);
      }
    },
    { prefix: API_PREFIX },
  );

  registerRealtime(app, ctx);

  return app;
}
