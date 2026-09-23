/**
 * Server entry point.
 *
 * Environment is validated before anything else, so a misconfigured deployment
 * fails in milliseconds with a readable message rather than 500ing on the first
 * request that happens to need a variable.
 */
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { startSweeper } from './modules/jobs/jobRunner.js';

async function main(): Promise<void> {
  const config = env();

  await mongoose.connect(config.MONGODB_URI, {
    dbName: config.MONGODB_DB_NAME,
    // A free-tier cluster has a small connection ceiling, and one pool for the
    // process is plenty for this workload.
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8000,
  });
  process.stdout.write(`connected to ${config.MONGODB_DB_NAME}\n`);

  // Reclaim anything a previous process was running when it was killed. This is
  // what stops a free instance that slept mid-generation leaving a kit that
  // spins forever.
  const sweeper = startSweeper();

  const server = createApp().listen(config.PORT, () => {
    process.stdout.write(`api listening on :${config.PORT}\n`);
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`\n${signal} received, shutting down\n`);
    clearInterval(sweeper);
    server.close(() => {
      void mongoose.disconnect().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
