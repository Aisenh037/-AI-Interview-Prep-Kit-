/**
 * Fetching an untrusted page.
 *
 * Every rule here exists because the brief says to "treat them as untrusted
 * throughout" and to "restrict handling to expected content types and sizes".
 *
 * Redirects are followed BY HAND and re-validated at every hop. Letting the HTTP
 * client follow them is an SSRF bypass: the first URL passes the guard, and hop
 * two lands on 169.254.169.254.
 *
 * The size cap is enforced WHILE STREAMING, not from Content-Length. A header is
 * advisory — frequently absent, occasionally a lie — and trusting it is how a
 * 512 MB instance gets killed by a page claiming to be 2 KB.
 *
 * DNS is resolved once, and the validated addresses are pinned into the
 * connection. Resolving and then connecting by hostname leaves a window in which
 * DNS can flip to a private address between the check and the connection.
 */
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { NetworkPolicy } from './networkPolicy.js';
import { validateUrl, type LookupFn, type UrlRejectionCode } from './urlGuard.js';

export const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/xml',
  'application/xml',
  'text/markdown',
];

export type FetchFailureCode =
  | UrlRejectionCode
  | 'FETCH_TIMEOUT'
  | 'FETCH_HTTP_ERROR'
  | 'FETCH_CONTENT_TYPE_REJECTED'
  | 'FETCH_TOO_LARGE'
  | 'FETCH_TOO_MANY_REDIRECTS'
  | 'FETCH_FAILED';

export interface FetchSuccess {
  ok: true;
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  /** Every URL in the redirect chain, first to last. */
  chain: string[];
  elapsedMs: number;
}

export interface FetchFailure {
  ok: false;
  url: string;
  code: FetchFailureCode;
  message: string;
  status?: number | undefined;
  elapsedMs: number;
}

export type FetchResult = FetchSuccess | FetchFailure;

export interface FetchOptions {
  policy: NetworkPolicy;
  userAgent?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  lookup?: LookupFn;
  now?: () => number;
  fetchImpl?: typeof undiciFetch;
}

const DEFAULTS = {
  userAgent: 'InterviewPrepKitBot/1.0 (+https://example.invalid/about-bot)',
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 12_000,
  maxRedirects: 3,
};

/**
 * Build a dispatcher that will only connect to addresses the policy approved.
 * The Host header and TLS SNI still carry the hostname, so certificate
 * validation is unaffected.
 */
function pinnedDispatcher(allowed: string[]): Dispatcher {
  const entries = allowed.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));

  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (entries.length === 0) {
          callback(new Error('no validated address to connect to'), '', 4);
          return;
        }

        // Hand back EVERY validated address when Node asks for them all, so it
        // can fall back between families. Returning only the first is a real
        // failure mode, not a theoretical one: `localhost` resolves to ::1
        // before 127.0.0.1 on Windows, so pinning to the first address alone
        // makes every fetch fail against an IPv4-only server.
        const wantsAll = (options as { all?: boolean } | undefined)?.all === true;
        if (wantsAll) {
          callback(null, entries as never);
          return;
        }

        const requested = (options as { family?: number } | undefined)?.family;
        const match =
          requested === 4 || requested === 6
            ? entries.find((entry) => entry.family === requested)
            : undefined;
        // IPv4 first by default: it is the more universally reachable of the two.
        const chosen = match ?? entries.find((entry) => entry.family === 4) ?? entries[0]!;
        callback(null, chosen.address, chosen.family);
      },
    },
  });
}

export async function fetchPage(rawUrl: string, options: FetchOptions): Promise<FetchResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  const chain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await validateUrl(current, options.policy, options.lookup);
    if (!check.ok) {
      return {
        ok: false,
        url: current,
        code: check.code,
        message: check.message,
        elapsedMs: now() - started,
      };
    }
    chain.push(check.url.toString());

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    const dispatcher = check.addresses.length > 0 ? pinnedDispatcher(check.addresses) : undefined;
    try {
      response = await fetchImpl(check.url.toString(), {
        method: 'GET',
        redirect: 'manual', // followed by hand so every hop is re-validated
        headers: {
          'user-agent': options.userAgent ?? DEFAULTS.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        },
        signal,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
      });
    } catch (error) {
      const err = error as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return {
        ok: false,
        url: current,
        code: timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED',
        message: err.message,
        elapsedMs: now() - started,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || location === '') {
        return {
          ok: false,
          url: current,
          code: 'FETCH_HTTP_ERROR',
          message: `redirect with no location (${response.status})`,
          status: response.status,
          elapsedMs: now() - started,
        };
      }
      // Resolve relative redirects against the URL we actually requested.
      current = new URL(location, check.url).toString();
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        url: check.url.toString(),
        code: 'FETCH_HTTP_ERROR',
        message: `HTTP ${response.status}`,
        status: response.status,
        elapsedMs: now() - started,
      };
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const mediaType = contentType.split(';')[0]?.trim() ?? '';
    if (mediaType !== '' && !ALLOWED_CONTENT_TYPES.includes(mediaType)) {
      return {
        ok: false,
        url: check.url.toString(),
        code: 'FETCH_CONTENT_TYPE_REJECTED',
        message: `content type ${mediaType} is not processed`,
        status: response.status,
        elapsedMs: now() - started,
      };
    }

    // Cheap rejection when the server is honest about an oversized body...
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false,
        url: check.url.toString(),
        code: 'FETCH_TOO_LARGE',
        message: `declared ${declared} bytes, over the ${maxBytes} cap`,
        status: response.status,
        elapsedMs: now() - started,
      };
    }

    // ...and the real enforcement, which does not trust that header.
    const read = await readCapped(response, maxBytes);
    if (read === null) {
      return {
        ok: false,
        url: check.url.toString(),
        code: 'FETCH_TOO_LARGE',
        message: `body exceeded the ${maxBytes} byte cap`,
        status: response.status,
        elapsedMs: now() - started,
      };
    }

    return {
      ok: true,
      url: check.url.toString(),
      status: response.status,
      contentType: mediaType,
      body: read.text,
      bytes: read.bytes,
      chain,
      elapsedMs: now() - started,
    };
  }

  return {
    ok: false,
    url: current,
    code: 'FETCH_TOO_MANY_REDIRECTS',
    message: `more than ${maxRedirects} redirects`,
    elapsedMs: now() - started,
  };
}

/** Read a body, aborting as soon as it passes the cap. Returns null if it did. */
async function readCapped(
  response: { body: unknown; text(): Promise<string> },
  maxBytes: number,
): Promise<{ text: string; bytes: number } | null> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body === null) return { text: '', bytes: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), bytes };
}
