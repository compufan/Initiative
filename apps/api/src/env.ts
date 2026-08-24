import { z } from 'zod';
import { randomBytes } from 'node:crypto';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value == null || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value)));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_SSL: bool(true),

  JWT_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(60),

  /** Public URL of the PWA; used for deep links in push notifications and ICS. */
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  /** Public URL of this API; used to build absolute media and calendar URLs. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:8080'),
  CORS_ORIGINS: csv,

  REGISTRATION_MODE: z.enum(['open', 'invite', 'closed']).default('open'),
  INVITE_CODES: csv,

  STORAGE_DRIVER: z.enum(['r2', 's3', 'local']).default('local'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),
  /** Optional CDN / r2.dev base URL that serves the bucket publicly. */
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  SIGNED_URL_TTL: z.coerce.number().int().min(60).default(3600),
  LOCAL_STORAGE_DIR: z.string().default('./.data/uploads'),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

  /** Broadcast realtime events through Postgres LISTEN/NOTIFY (multi-instance). */
  REALTIME_BUS: z.enum(['memory', 'postgres']).default('postgres'),
  TRUST_PROXY: bool(true),
});

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
  jwtSecret: string;
  pushEnabled: boolean;
};

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';

  if (isProduction && !value.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production (generate with: openssl rand -base64 48)');
  }
  if (value.STORAGE_DRIVER !== 'local') {
    const missing = (['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (key) => !value[key],
    );
    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=${value.STORAGE_DRIVER} requires: ${missing.join(', ')}`);
    }
    if (value.STORAGE_DRIVER === 'r2' && !value.S3_ENDPOINT) {
      throw new Error('STORAGE_DRIVER=r2 requires S3_ENDPOINT (https://<account-id>.r2.cloudflarestorage.com)');
    }
  }

  cached = {
    ...value,
    isProduction,
    jwtSecret: value.JWT_SECRET ?? randomBytes(32).toString('hex'),
    pushEnabled: Boolean(value.VAPID_PUBLIC_KEY && value.VAPID_PRIVATE_KEY),
  };
  return cached;
}

export function env(): Env {
  if (!cached) return loadEnv();
  return cached;
}
