import postgres from 'postgres';
import { env } from '../env.js';

/**
 * Single Postgres pool for the process.
 *
 * Column names are snake_case in SQL and camelCase in JavaScript – postgres.js
 * translates both directions, so queries read `select display_name` and rows
 * come back as `{ displayName }`.
 */
export type Sql = postgres.Sql<Record<string, never>>;
export type Transaction = postgres.TransactionSql<Record<string, never>>;

let client: Sql | null = null;

function shouldUseSsl(url: string): boolean {
  if (/sslmode=disable/i.test(url)) return false;
  if (/sslmode=/i.test(url)) return true;
  if (/@(localhost|127\.0\.0\.1|host\.docker\.internal|postgres)[:/]/i.test(url)) return false;
  return env().DATABASE_SSL;
}

export function createClient(url = env().DATABASE_URL, max = env().DATABASE_POOL_MAX): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 15,
    ssl: shouldUseSsl(url) ? 'require' : false,
    transform: {
      column: { to: postgres.fromCamel, from: postgres.toCamel },
      undefined: null,
    },
    onnotice: () => {},
  });
}

export function db(): Sql {
  if (!client) client = createClient();
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    const current = client;
    client = null;
    await current.end({ timeout: 5 });
  }
}

/** Wrap an arbitrary value as a jsonb parameter (`sql.json` wants JSONValue). */
export function jsonb(sql: Sql | Transaction, value: unknown) {
  return sql.json(value as never);
}
