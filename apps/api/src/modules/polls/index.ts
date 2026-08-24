import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { defineModule } from '../types.js';

// TODO(module): implemented in apps/api/src/modules/polls
export default defineModule({
  key: 'polls',
  description: 'Platzhalter – wird durch die Modulimplementierung ersetzt',
  register(_app: FastifyInstance, _ctx: AppContext) {
    /* no routes yet */
  },
});
