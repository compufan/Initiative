import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Env } from '../env.js';
import type { ObjectStream, PresignedUpload, StorageDriver } from './types.js';

/** Disk backed storage for development and single-container self-hosting. */
export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  readonly supportsPresignedUpload = false;
  private readonly root: string;

  constructor(env: Env) {
    this.root = resolve(env.LOCAL_STORAGE_DIR);
  }

  private pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('invalid storage key');
    }
    return target;
  }

  async createPresignedUpload(): Promise<PresignedUpload> {
    throw new Error('local storage does not support presigned uploads');
  }

  async createDownloadUrl(): Promise<string | null> {
    // null → the API streams the object itself (see the media module).
    return null;
  }

  async put(key: string, body: Buffer | Readable, mime: string): Promise<void> {
    void mime;
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await pipeline(Readable.from(body), createWriteStream(target));
    } else {
      await pipeline(body, createWriteStream(target));
    }
  }

  async createReadStream(key: string): Promise<ObjectStream | null> {
    const target = this.pathFor(key);
    try {
      const stats = await stat(target);
      return { stream: createReadStream(target), size: stats.size, mime: null };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
