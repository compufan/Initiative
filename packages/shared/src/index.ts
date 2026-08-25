/**
 * Gemeinsame Contracts der PWA.
 *
 * Die Rust-API (`apps/api`) ist die Quelle der Wahrheit für den HTTP- und
 * Realtime-Vertrag; dieses Paket spiegelt ihn für das Frontend: dieselben
 * Feldnamen (camelCase), dieselben Grenzwerte, dasselbe Envelope-Format.
 * Wer einen Endpunkt oder ein Limit ändert, ändert beide Seiten.
 */
export * from './constants.js';
export * from './ids.js';

export * from './schemas/common.js';
export * from './schemas/auth.js';
export * from './schemas/user.js';
export * from './schemas/media.js';
export * from './schemas/conversation.js';
export * from './schemas/message.js';
export * from './schemas/sticker.js';
export * from './schemas/collection.js';
export * from './schemas/calendar.js';
export * from './schemas/poll.js';
export * from './schemas/game.js';
export * from './schemas/push.js';

export * from './realtime/events.js';

export * from './games/types.js';
export * from './games/registry.js';
export * from './games/tic-tac-toe.js';
export * from './games/connect-four.js';

export * from './util/poll.js';
export * from './util/recurrence.js';
export * from './util/ics.js';
export * from './util/format.js';
