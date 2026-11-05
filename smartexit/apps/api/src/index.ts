import { configuredApiHost, createApp } from './app.js';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '../../.env') });

const port = Number(process.env.PORT ?? 3001);
const host = configuredApiHost();
const { app, db } = createApp();
const server = app.listen(port, host, () => {
  console.log(`Market data API listening at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void db.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('Failed to close the Supabase database pool:', error);
          process.exit(1);
        },
      );
    });
  });
}
