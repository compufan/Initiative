import { loadEnv } from './env.js';
import { createContext } from './context.js';
import { buildApp } from './app.js';
import { closeDb, db } from './db/client.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = createContext(env);

  if (process.env.RUN_MIGRATIONS !== 'false') {
    const applied = await runMigrations(db());
    if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);
  }

  const app = await buildApp(ctx);
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(
    { storage: ctx.storage.kind, bus: ctx.bus.kind, push: ctx.push.enabled },
    'Initiative API ready',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    ctx.hub.closeAll();
    await app.close().catch(() => {});
    await ctx.bus.close().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
