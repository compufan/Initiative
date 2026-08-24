import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env.js';
import type { ByteRange, ObjectStream, PresignedUpload, StorageDriver } from './types.js';

/** Works with Cloudflare R2, AWS S3, MinIO, Backblaze B2 – anything S3 compatible. */
export class S3Storage implements StorageDriver {
  readonly kind: 'r2' | 's3';
  readonly supportsPresignedUpload = true;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttl: number;
  private readonly publicBaseUrl: string | null;

  constructor(env: Env) {
    this.kind = env.STORAGE_DRIVER === 'r2' ? 'r2' : 's3';
    this.bucket = env.S3_BUCKET!;
    this.ttl = env.SIGNED_URL_TTL;
    this.publicBaseUrl = env.S3_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? null;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }

  async createPresignedUpload(key: string, mime: string, size: number): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mime,
      ContentLength: size,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: 900 });
    return {
      url,
      // R2 rejects the PUT when these differ from the signed values.
      headers: { 'content-type': mime },
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  async createDownloadUrl(
    key: string,
    options?: { fileName?: string | null; mime?: string | null; download?: boolean },
  ): Promise<string | null> {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: options?.mime ?? undefined,
      ResponseContentDisposition: options?.download
        ? `attachment; filename="${sanitise(options.fileName ?? 'download')}"`
        : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: this.ttl });
  }

  async put(key: string, body: Buffer | Readable, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }),
    );
  }

  async createReadStream(key: string, range?: ByteRange): Promise<ObjectStream | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
        }),
      );
      if (!result.Body) return null;
      const total = result.ContentRange
        ? Number.parseInt(result.ContentRange.split('/')[1] ?? '', 10)
        : (result.ContentLength ?? null);
      return {
        stream: result.Body as Readable,
        size: result.ContentLength ?? null,
        totalSize: Number.isNaN(total as number) ? null : total,
        mime: result.ContentType ?? null,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function sanitise(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}
