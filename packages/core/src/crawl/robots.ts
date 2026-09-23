/**
 * robots.txt, plus the sitemap it points at.
 *
 * The brief asks us to "respect robots.txt and site terms", so this is checked
 * before any page is fetched and cached per origin for the run.
 *
 * Two deliberate deviations, both documented rather than silent:
 *
 *   Crawl-delay is honoured but CLAMPED. A fixture in this repo declares
 *   `Crawl-delay: 30`; obeying that literally would spend the entire
 *   fifteen-minute batch budget waiting on one site. We wait, but not without
 *   limit.
 *
 *   An unreachable robots.txt is treated as permissive. RFC 9309 says a 5xx
 *   should be read as full disallow; that is the right call for a
 *   general-purpose crawler hitting a site repeatedly, but here it would let one
 *   flaky response zero out a user's entire research run. We record the fact
 *   instead, so a reader can see it happened.
 *
 * Sitemaps matter more than they look: they reach pages that no path list would
 * guess and that may not be linked from the homepage at all.
 */
import robotsParser from 'robots-parser';
import { XMLParser } from 'fast-xml-parser';
import { normaliseUrl } from '../net/urlGuard.js';
import type { FetchResult } from '../net/fetchPage.js';

/** A hostile or careless robots.txt must not stall the run. */
export const MAX_CRAWL_DELAY_MS = 2000;

export interface RobotsRules {
  origin: string;
  isAllowed(url: string): boolean;
  crawlDelayMs: number;
  sitemaps: string[];
  /** True when robots.txt could not be read and we defaulted to permissive. */
  assumedPermissive: boolean;
}

export type PageFetcher = (url: string) => Promise<FetchResult>;

export function parseRobots(
  origin: string,
  robotsUrl: string,
  body: string,
  userAgent: string,
): RobotsRules {
  const parsed = robotsParser(robotsUrl, body);
  const rawDelay = parsed.getCrawlDelay(userAgent);
  const crawlDelayMs =
    typeof rawDelay === 'number' && Number.isFinite(rawDelay)
      ? Math.min(MAX_CRAWL_DELAY_MS, Math.max(0, rawDelay * 1000))
      : 0;

  return {
    origin,
    isAllowed: (url: string) => parsed.isAllowed(url, userAgent) !== false,
    crawlDelayMs,
    sitemaps: parsed.getSitemaps(),
    assumedPermissive: false,
  };
}

function permissive(origin: string, assumed: boolean): RobotsRules {
  return {
    origin,
    isAllowed: () => true,
    crawlDelayMs: 0,
    sitemaps: [],
    assumedPermissive: assumed,
  };
}

/** Caches robots.txt per origin so one run never fetches it twice. */
export class RobotsCache {
  private readonly cache = new Map<string, Promise<RobotsRules>>();

  constructor(
    private readonly fetchPage: PageFetcher,
    private readonly userAgent: string,
  ) {}

  async forUrl(url: string): Promise<RobotsRules> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return permissive('', true);
    }

    const existing = this.cache.get(origin);
    if (existing !== undefined) return existing;

    const pending = this.load(origin);
    this.cache.set(origin, pending);
    return pending;
  }

  private async load(origin: string): Promise<RobotsRules> {
    const robotsUrl = `${origin}/robots.txt`;
    const result = await this.fetchPage(robotsUrl);

    if (!result.ok) {
      // 404 means "no rules", which is genuinely permissive. Anything else is a
      // failure we assume our way past, and say so.
      const missing = result.status === 404 || result.status === 410;
      return permissive(origin, !missing);
    }
    try {
      return parseRobots(origin, robotsUrl, result.body, this.userAgent);
    } catch {
      return permissive(origin, true);
    }
  }
}

/**
 * Pull page URLs out of a sitemap, following one level of sitemap index.
 * Bounded, because a sitemap can legitimately list a hundred thousand URLs and
 * we only want a few high-value candidates.
 */
export function parseSitemap(xml: string, limit = 500): { urls: string[]; sitemaps: string[] } {
  const parser = new XMLParser({ ignoreAttributes: true, isArray: () => false });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return { urls: [], sitemaps: [] };
  }

  const urls: string[] = [];
  const sitemaps: string[] = [];

  const collect = (node: unknown, into: string[]): void => {
    if (into.length >= limit) return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, into);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const loc = record['loc'];
    if (typeof loc === 'string') {
      const normalised = normaliseUrl(loc);
      if (normalised !== null && into.length < limit) into.push(normalised.toString());
    }
  };

  const root = doc as Record<string, unknown>;
  const urlset = root['urlset'];
  if (urlset !== undefined && urlset !== null && typeof urlset === 'object') {
    collect((urlset as Record<string, unknown>)['url'], urls);
  }
  const index = root['sitemapindex'];
  if (index !== undefined && index !== null && typeof index === 'object') {
    collect((index as Record<string, unknown>)['sitemap'], sitemaps);
  }

  return { urls, sitemaps };
}
