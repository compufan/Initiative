import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Sql } from './client.js';
import { loadEnv } from '../env.js';

async function findMigrationsDir(): Promise<string> {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'migrations');
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  throw new Error('migrations directory not found');
}

export async function runMigrations(sql: Sql): Promise<string[]> {
  const dir = await findMigrationsDir();
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name),
  );
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const executed: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(join(dir, file), 'utf8');
    // Simple protocol so a migration file may contain multiple statements.
    await sql.unsafe(content).simple();
    await sql`insert into schema_migrations ${sql({ name: file })}`;
    executed.push(file);
  }
  return executed;
}

const isEntrypoint =
  process.argv[1] != null && import.meta.url === `file://${resolve(process.argv[1])}`;

if (isEntrypoint) {
  loadEnv();
  const sql = createClient();
  runMigrations(sql)
    .then(async (executed) => {
      console.log(
        executed.length > 0
          ? `Applied ${executed.length} migration(s): ${executed.join(', ')}`
          : 'Database is up to date.',
      );
      await sql.end({ timeout: 5 });
    })
    .catch(async (error: unknown) => {
      console.error('Migration failed:', error);
      await sql.end({ timeout: 5 }).catch(() => {});
      process.exitCode = 1;
    });
}
