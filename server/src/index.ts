import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { SqliteStore } from './store/sqlite.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const store = new SqliteStore(config.databasePath);
  await store.migrate();
  const app = createApp({ store, config, fetch: globalThis.fetch, now: () => new Date(), newId: () => randomUUID() });

  // housekeeping: expired sessions / oauth states and abandoned guest sandboxes
  const sweep = async () => {
    const now = new Date();
    await store.purgeExpiredSessions(now.toISOString());
    await store.purgeExpiredOAuthStates(now.toISOString());
    await store.purgeExpiredGuests(new Date(now.getTime() - config.guestTtlHours * 3_600_000).toISOString());
  };
  await sweep();
  const timer = setInterval(() => void sweep().catch((e) => console.error('sweep failed', e)), 15 * 60_000);
  timer.unref();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`Breakpoint API listening on http://${info.address}:${info.port}  (${config.env})`);
    console.log(`  database:  ${config.databasePath}`);
    console.log(`  CORS:      ${config.appOrigins.join(', ')}`);
    console.log(`  Google:    ${config.google ? 'configured' : 'not configured (guest demo + .ics import still work)'}`);
    if (config.env !== 'production') console.log('  Try:       curl http://localhost:' + info.port + '/api/demo/schedule');
  });

  const shutdown = (sig: string) => {
    console.log(`${sig} received, shutting down`);
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
