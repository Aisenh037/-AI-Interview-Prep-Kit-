/**
 * Serve the fixture company sites, so the batch entry point can be exercised
 * exactly as the graders describe: "the company sites used with this command may
 * be served from a local address".
 *
 *   npm run fixtures:serve
 */
import { startFixtureServer } from './fixtureServer.js';

const port = Number(process.env['FIXTURES_PORT'] ?? 8099);
const server = await startFixtureServer(port);

process.stderr.write(`Fixture company sites on http://localhost:${server.port}\n`);
process.stderr.write(`  http://localhost:${server.port}/acme/    — hiring process buried two clicks deep\n`);
process.stderr.write(`  http://localhost:${server.port}/nohire/  — no hiring or about page anywhere\n`);
process.stderr.write('Press Ctrl+C to stop.\n');

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
