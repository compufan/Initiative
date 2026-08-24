import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { defineModule } from '../types.js';

// TODO(module): implemented in apps/api/src/modules/stickers
export default defineModule({
  key: 'stickers',
  description: 'Platzhalter – wird durch die Modulimplementierung ersetzt',
  register(_app: FastifyInstance, _ctx: AppContext) {
    /* no routes yet */
  },
});
