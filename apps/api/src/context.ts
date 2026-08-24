import type { Env } from './env.js';
import { db, type Sql } from './db/client.js';
import { createStorage, type StorageDriver } from './storage/index.js';
import { createBus, type RealtimeBus } from './realtime/bus.js';
import { RealtimeHub } from './realtime/hub.js';
import { PushService } from './push/index.js';

/**
 * Everything a feature module needs. Passed to `AppModule.register` so modules
 * never reach for global singletons and stay testable in isolation.
 */
export interface AppContext {
  env: Env;
  sql: Sql;
  storage: StorageDriver;
  bus: RealtimeBus;
  hub: RealtimeHub;
  push: PushService;
}

export function createContext(env: Env): AppContext {
  const sql = db();
  const bus = createBus(env, sql);
  const hub = new RealtimeHub(bus);
  return {
    env,
    sql,
    storage: createStorage(env),
    bus,
    hub,
    push: new PushService(env, sql),
  };
}
