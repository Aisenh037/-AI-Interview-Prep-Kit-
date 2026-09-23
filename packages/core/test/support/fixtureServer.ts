/**
 * A static server for the fixture company sites.
 *
 * It mirrors the harness the brief describes — "the company sites used with this
 * command may be served from a local address" — so the crawler is exercised over
 * real HTTP, with real relative links, rather than against strings in memory.
 *
 * A few paths behave badly on purpose, because the failure paths are the ones
 * worth testing: a slow page, an oversized one, a wrong content type, and a
 * redirect into cloud-metadata space.
 */
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('../fixtures/sites/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

export interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  /** Every path the server was asked for, so tests can assert what was NOT fetched. */
  readonly requests: string[];
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    requests.push(pathname);

    void (async () => {
      // --- deliberately badly behaved endpoints -----------------------------
      if (pathname === '/slow') {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        res.writeHead(200, { 'content-type': 'text/html' }).end('<p>too late</p>');
        return;
      }
      if (pathname === '/big.html') {
        // No content-length at all, so the client must stream it. This is the
        // case the cap actually has to catch: a declared length can be checked
        // cheaply up front, but a chunked response only reveals its size as it
        // arrives.
        res.writeHead(200, { 'content-type': 'text/html', 'transfer-encoding': 'chunked' });
        const chunk = 'x'.repeat(64 * 1024);
        // Written without regard for backpressure on purpose: the point is to
        // push well past any cap the client sets, so the abort path is real.
        for (let i = 0; i < 32; i += 1) res.write(chunk);
        res.end();
        return;
      }
      if (pathname === '/big-declared.html') {
        // Honest about being oversized, so it can be rejected before download.
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-length': String(50 * 1024 * 1024),
        });
        res.end('x'.repeat(1024));
        return;
      }
      if (pathname === '/brochure.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 fake');
        return;
      }
      if (pathname === '/evil-redirect') {
        // Hop two lands on cloud metadata; the guard must catch it there.
        res
          .writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
          .end();
        return;
      }
      if (pathname === '/redirect-to-careers') {
        res.writeHead(302, { location: '/acme/company/joining-us/' }).end();
        return;
      }
      if (pathname === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' }).end();
        return;
      }

      // --- ordinary static files -------------------------------------------
      const relative = normalize(pathname).replace(/^([/\\])+/, '');
      // Path traversal is refused rather than merely unlikely.
      if (relative.split(sep).includes('..')) {
        res.writeHead(403).end('no');
        return;
      }

      const candidates = [join(ROOT, relative)];
      if (!extname(relative)) {
        candidates.push(join(ROOT, relative, 'index.html'));
      }

      for (const candidate of candidates) {
        try {
          const info = await stat(candidate);
          if (!info.isFile()) continue;
          const body = await readFile(candidate);
          res
            .writeHead(200, {
              'content-type': CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream',
              'content-length': String(body.byteLength),
            })
            .end(body);
          return;
        } catch {
          // try the next candidate
        }
      }

      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: actualPort,
    origin: `http://127.0.0.1:${actualPort}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
