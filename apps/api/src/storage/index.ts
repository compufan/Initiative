import type { Env } from '../env.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { StorageDriver } from './types.js';

export * from './types.js';

export function createStorage(env: Env): StorageDriver {
  return env.STORAGE_DRIVER === 'local' ? new LocalStorage(env) : new S3Storage(env);
}
