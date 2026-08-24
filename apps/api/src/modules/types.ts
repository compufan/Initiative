import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * A feature module owns its routes, its realtime events and (optionally) the
 * way its entities are embedded into chat messages. The messenger itself is
 * just the first module – calendar, polls and mini-games are siblings, and new
 * areas of the app are added by dropping another module in here.
 */
export interface AppModule {
  key: string;
  description: string;
  /** Called once during boot; routes are mounted under `/api/v1`. */
  register(app: FastifyInstance, ctx: AppContext): Promise<void> | void;
}

export function defineModule(module: AppModule): AppModule {
  return module;
}
