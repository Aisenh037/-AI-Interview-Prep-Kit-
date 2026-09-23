/**
 * Crawling a company site to find what they do and how they hire.
 *
 * Best-first rather than breadth-first: the frontier is a priority queue ordered
 * by the link ranker, so the crawl spends its small page budget on the links most
 * likely to be worth fetching instead of walking the site in link order.
 *
 * Scope is the BASE PATH, not merely the origin. The batch harness may serve
 * several company sites from one port — http://localhost:8099/acme/ and
 * http://localhost:8099/nohire/ — and an origin-scoped crawl would wander from
 * one company into another and report the wrong research entirely.
 *
 * Every attempt is recorded, successful or not. "Skip and report a source that
 * cannot be retrieved, rather than failing the whole run" is a requirement, and
 * the log is what turns that from a claim into something a user can see.
 */
import { extractPage, type CleanPage } from './extract.js';
import { assessHiringPage, needsModelRerank, rankLinks, type RankedLink } from './rankLinks.js';
import { RobotsCache, parseSitemap, type PageFetcher } from './robots.js';
import { normaliseUrl } from '../net/urlGuard.js';
import type { Clock } from '../llm/rateLimiter.js';
import { systemClock } from '../llm/rateLimiter.js';

export interface FetchAttempt {
  url: string;
  outcome: 'ok' | 'skipped' | 'failed';
  code?: string;
  status?: number | undefined;
  bytes?: number;
  reason?: string;
}

export interface CrawlBudget {
  maxPages?: number;
  maxDepth?: number;
  maxWallClockMs?: number;
  politenessMs?: number;
}

export interface CrawlOptions extends CrawlBudget {
  fetchPage: PageFetcher;
  userAgent?: string;
  clock?: Clock;
  signal?: AbortSignal;
  /** Optional model-backed re-rank, used only when the heuristic is unsure. */
  rerank?: (candidates: RankedLink[]) => Promise<string[]>;
}

export interface CrawlResult {
  /** The page at the URL the user gave us, if it could be read at all. */
  root: CleanPage | null;
  pages: CleanPage[];
  /** The page that best describes what the company does. */
  aboutPage: CleanPage | null;
  /** The page that describes how they hire, if one exists. */
  hiringPage: CleanPage | null;
  hiringConfidence: 'confident' | 'weak' | 'none';
  hiringSignals: { systemDesign: boolean; takeHome: boolean; pairing: boolean; values: boolean };
  stageTerms: string[];
  attempts: FetchAttempt[];
  warnings: string[];
  /** Exactly the URLs whose content informed the kit. */
  pagesUsed: string[];
}

const DEFAULTS = {
  maxPages: 12,
  maxDepth: 2,
  maxWallClockMs: 45_000,
  politenessMs: 350,
};

/** True when `url` lives under the same site as `base` — origin AND base path. */
export function inScope(url: string, base: string): boolean {
  let target: URL;
  let root: URL;
  try {
    target = new URL(url);
    root = new URL(base);
  } catch {
    return false;
  }
  if (target.origin !== root.origin) return false;

  // Treat the last segment of the seed as a file unless it ends in a slash.
  const basePath = root.pathname.endsWith('/')
    ? root.pathname
    : `${root.pathname.slice(0, root.pathname.lastIndexOf('/') + 1)}`;
  if (basePath === '/' || basePath === '') return true;
  return target.pathname === basePath.slice(0, -1) || target.pathname.startsWith(basePath);
}

export async function crawlSite(seedUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const clock = options.clock ?? systemClock;
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const deadline = clock.now() + (options.maxWallClockMs ?? DEFAULTS.maxWallClockMs);
  const userAgent = options.userAgent ?? 'InterviewPrepKitBot/1.0';

  const attempts: FetchAttempt[] = [];
  const warnings: string[] = [];
  const pages: CleanPage[] = [];
  const visited = new Set<string>();
  const inboundCounts = new Map<string, number>();
  const sitemapUrls = new Set<string>();

  const seed = normaliseUrl(seedUrl);
  if (seed === null) {
    return emptyResult(attempts, ['COMPANY_URL_INVALID']);
  }
  const seedString = seed.toString();

  const robots = new RobotsCache(options.fetchPage, userAgent);
  const rules = await robots.forUrl(seedString);
  if (rules.assumedPermissive) warnings.push('ROBOTS_UNREACHABLE');

  // A sitemap reaches pages that are not linked from the homepage at all.
  for (const sitemap of rules.sitemaps.slice(0, 2)) {
    const result = await options.fetchPage(sitemap);
    if (!result.ok) {
      attempts.push({ url: sitemap, outcome: 'failed', code: result.code });
      continue;
    }
    attempts.push({ url: sitemap, outcome: 'ok', bytes: result.bytes });
    for (const url of parseSitemap(result.body).urls) {
      if (inScope(url, seedString)) sitemapUrls.add(url);
    }
  }

  interface QueueItem {
    url: string;
    depth: number;
    priority: number;
  }
  const frontier: QueueItem[] = [{ url: seedString, depth: 0, priority: Number.MAX_SAFE_INTEGER }];

  let lastFetchAt = 0;
  let rerankApplied = false;

  while (frontier.length > 0 && pages.length < maxPages) {
    if (options.signal?.aborted === true) {
      warnings.push('CRAWL_ABORTED');
      break;
    }
    if (clock.now() > deadline) {
      warnings.push('CRAWL_BUDGET_EXCEEDED');
      break;
    }

    frontier.sort((a, b) => b.priority - a.priority);
    const next = frontier.shift();
    if (next === undefined) break;
    if (visited.has(next.url)) continue;
    visited.add(next.url);

    if (!rules.isAllowed(next.url)) {
      attempts.push({ url: next.url, outcome: 'skipped', code: 'ROBOTS_DISALLOWED' });
      continue;
    }

    // Be polite to the host, but not to our own fixture server: there is no one
    // to be polite to, and it would spend seconds of the batch budget.
    const delay = isLoopback(next.url) ? 0 : Math.max(rules.crawlDelayMs, options.politenessMs ?? DEFAULTS.politenessMs);
    const sinceLast = clock.now() - lastFetchAt;
    if (lastFetchAt !== 0 && sinceLast < delay) {
      await clock.sleep(delay - sinceLast, options.signal);
    }

    const result = await options.fetchPage(next.url);
    lastFetchAt = clock.now();

    if (!result.ok) {
      attempts.push({
        url: next.url,
        outcome: 'failed',
        code: result.code,
        status: result.status,
        reason: result.message,
      });
      continue;
    }

    attempts.push({ url: result.url, outcome: 'ok', status: result.status, bytes: result.bytes });
    const page = extractPage(result.body, result.url);
    pages.push(page);

    if (next.depth >= maxDepth) continue;

    const candidates = page.links.filter((link) => inScope(link.url, seedString));
    for (const link of candidates) {
      inboundCounts.set(link.url, (inboundCounts.get(link.url) ?? 0) + 1);
    }

    const ranked = rankLinks(candidates, { sitemapUrls, inboundCounts });

    // One model call, and only when keywords genuinely cannot separate the
    // candidates — for example a link reading "Handbook" with no hiring
    // vocabulary anywhere near it.
    if (!rerankApplied && options.rerank !== undefined && needsModelRerank(ranked)) {
      rerankApplied = true;
      try {
        const preferred = await options.rerank(ranked.slice(0, 12));
        const boost = new Map(preferred.map((url, index) => [url, 10 - index]));
        for (const item of ranked) item.score += boost.get(item.url) ?? 0;
        ranked.sort((a, b) => b.score - a.score);
      } catch {
        warnings.push('RERANK_UNAVAILABLE');
      }
    }

    for (const link of ranked) {
      if (visited.has(link.url)) continue;
      if (link.score <= -4) continue; // plainly noise: legal, login, pricing
      frontier.push({ url: link.url, depth: next.depth + 1, priority: link.score });
    }
  }

  return classify(seedString, pages, attempts, warnings);
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function emptyResult(attempts: FetchAttempt[], warnings: string[]): CrawlResult {
  return {
    root: null,
    pages: [],
    aboutPage: null,
    hiringPage: null,
    hiringConfidence: 'none',
    hiringSignals: { systemDesign: false, takeHome: false, pairing: false, values: false },
    stageTerms: [],
    attempts,
    warnings,
    pagesUsed: [],
  };
}

/**
 * Decide which fetched pages are the about page and the hiring page.
 * Deterministic, and based on the page's TEXT rather than its URL — a page
 * called /careers that says nothing about the process is not a hiring page.
 */
function classify(
  seedUrl: string,
  pages: CleanPage[],
  attempts: FetchAttempt[],
  warnings: string[],
): CrawlResult {
  if (pages.length === 0) {
    return emptyResult(attempts, [...warnings, 'COMPANY_SITE_UNREACHABLE']);
  }

  const root = pages.find((p) => p.url === seedUrl) ?? pages[0] ?? null;

  let hiringPage: CleanPage | null = null;
  let best = { confidence: 'none' as 'confident' | 'weak' | 'none', terms: 0 };
  let signals = { systemDesign: false, takeHome: false, pairing: false, values: false };
  let stageTerms: string[] = [];

  for (const page of pages) {
    const assessment = assessHiringPage(page.text);
    if (assessment.confidence === 'none') continue;
    const better =
      (assessment.confidence === 'confident' && best.confidence !== 'confident') ||
      (assessment.confidence === best.confidence && assessment.stageTerms.length > best.terms);
    if (hiringPage === null || better) {
      hiringPage = page;
      best = { confidence: assessment.confidence, terms: assessment.stageTerms.length };
      signals = assessment.signals;
      stageTerms = assessment.stageTerms;
    }
  }

  // The about page is whichever page most describes the company, preferring an
  // explicit about page but falling back to the root rather than inventing one.
  const aboutRanked = rankLinks(
    pages.map((page) => ({
      url: page.url,
      anchor: page.title,
      inChrome: false,
      context: page.metaDescription,
      depth: 1,
    })),
    { profile: 'about' },
  );
  const aboutUrl = aboutRanked[0]?.url;
  const aboutPage =
    (aboutRanked[0]?.score ?? 0) > 0
      ? (pages.find((p) => p.url === aboutUrl) ?? root)
      : root;

  const finalWarnings = [...warnings];
  if (hiringPage === null) finalWarnings.push('NO_HIRING_PAGE_FOUND');
  if (aboutPage === null || aboutPage === root) {
    if (!pages.some((p) => /about|company|mission/i.test(p.url))) {
      finalWarnings.push('NO_ABOUT_PAGE_FOUND');
    }
  }

  return {
    root,
    pages,
    aboutPage,
    hiringPage,
    hiringConfidence: best.confidence,
    hiringSignals: signals,
    stageTerms,
    attempts,
    warnings: finalWarnings,
    pagesUsed: pages.map((p) => p.url),
  };
}
