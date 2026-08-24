import auth from './auth/index.js';
import users from './users/index.js';
import conversations from './conversations/index.js';
import messages from './messages/index.js';
import media from './media/index.js';
import stickers from './stickers/index.js';
import calendar from './calendar/index.js';
import polls from './polls/index.js';
import games from './games/index.js';
import push from './push/index.js';
import type { AppModule } from './types.js';

/**
 * Registered feature modules, in boot order.
 *
 * Adding a feature to Initiative means creating `modules/<name>/index.ts` with
 * `defineModule({ … })` and adding one line here – nothing else in the core has
 * to change.
 */
export const modules: AppModule[] = [
  auth,
  users,
  conversations,
  messages,
  media,
  stickers,
  calendar,
  polls,
  games,
  push,
];
