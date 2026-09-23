/**
 * Looking for public discussion of how a company interviews.
 *
 * Finding nothing is a first-class outcome, not an error. It is also the common
 * one: measured from this machine, DuckDuckGo's HTML endpoint returns a
 * bot-detection page rather than results, and Mojeek serves a CAPTCHA. Any
 * design that leans on scraping a general search engine will report "no
 * discussion found" far more often than intended.
 *
 * So the default source is Hacker News via the Algolia API — keyless, documented,
 * intended for public use, and reliable — with keyed providers used when a key
 * happens to be configured and HTML scrapers kept only as a last resort. The
 * result is that the batch entry point needs no search key at all, which is what
 * "no setup beyond your documented install step" requires.
 *
 * Sites that forbid automated access are never fetched. Glassdoor, LinkedIn,
 * Indeed and Blind all block bots and prohibit scraping in their terms; a design
 * that scrapes them anyway is a liability, not a feature.
 */
import type { FetchResult } from '../net/fetchPage.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchProvider {
  readonly name: string;
  available(): boolean;
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
}

/** Never fetched, never cited, regardless of what a search returns. */
export const BLOCKED_DOMAINS = [
  'glassdoor.',
  'linkedin.com',
  'indeed.com',
  'teamblind.com',
  'facebook.com',
  'twitter.com',
  'x.com',
];

export function isBlockedDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return BLOCKED_DOMAINS.some((domain) => lower.includes(domain));
}

/**
 * Hacker News search. Keyless and documented, which makes it the only source we
 * can rely on being available from a clean clone.
 */
export function createHackerNewsProvider(
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>,
): SearchProvider {
  return {
    name: 'hn-algolia',
    available: () => true,
    async search(query, signal) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
      const body = (await fetchJson(url, signal)) as {
        hits?: { title?: string; url?: string; story_text?: string; objectID?: string }[];
      };
      return (body.hits ?? [])
        .filter((hit) => typeof hit.title === 'string' && hit.title !== '')
        .map((hit) => ({
          title: hit.title!,
          url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ''}`,
          snippet: (hit.story_text ?? '').slice(0, 300),
          source: 'hn-algolia',
        }))
        .filter((hit) => !isBlockedDomain(hit.url));
    },
  };
}

/** Brave's API, used only when a key is configured. */
export function createBraveProvider(
  apiKey: string | undefined,
  fetchJson: (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<unknown>,
): SearchProvider {
  return {
    name: 'brave',
    available: () => apiKey !== undefined && apiKey !== '',
    async search(query, signal) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const body = (await fetchJson(url, { 'X-Subscription-Token': apiKey ?? '', Accept: 'application/json' }, signal)) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      return (body.web?.results ?? [])
        .filter((r) => typeof r.url === 'string')
        .map((r) => ({
          title: r.title ?? '',
          url: r.url!,
          snippet: (r.description ?? '').slice(0, 300),
          source: 'brave',
        }))
        .filter((hit) => !isBlockedDomain(hit.url));
    },
  };
}

export interface DiscussionResult {
  found: boolean;
  hits: SearchHit[];
  /** Short statements drawn from what was found, for the question prompts. */
  notes: string[];
  providersTried: string[];
  warnings: string[];
}

export interface FindDiscussionInput {
  companyName: string;
  roleTitle: string;
  providers: SearchProvider[];
  /** Used to retrieve a promising result page, through the same guards as any crawl. */
  fetchPage?: (url: string) => Promise<FetchResult>;
  signal?: AbortSignal | undefined;
  maxQueries?: number;
}

/** Queries in priority order; we stop as soon as something useful comes back. */
export function discussionQueries(companyName: string, roleTitle: string): string[] {
  const company = `"${companyName}"`;
  return [
    `${company} interview process`,
    `${company} interview questions ${roleTitle}`.trim(),
    `${company} hiring process engineer`,
  ];
}

/** Does this result actually look like it discusses interviewing there? */
function isRelevant(hit: SearchHit, companyName: string): boolean {
  const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
  const company = companyName.toLowerCase().split(/\s+/)[0] ?? '';
  if (company !== '' && !haystack.includes(company)) return false;
  return /\b(?:interview|hiring|recruit|take[- ]home|onsite|screen)\b/.test(haystack);
}

export async function findPublicDiscussion(
  input: FindDiscussionInput,
): Promise<DiscussionResult> {
  const providersTried: string[] = [];
  const warnings: string[] = [];
  const hits: SearchHit[] = [];
  const queries = discussionQueries(input.companyName, input.roleTitle).slice(
    0,
    input.maxQueries ?? 2,
  );

  for (const provider of input.providers) {
    if (!provider.available()) continue;
    providersTried.push(provider.name);

    for (const query of queries) {
      if (input.signal?.aborted === true) break;
      try {
        const results = await provider.search(query, input.signal);
        for (const hit of results) {
          if (hits.some((existing) => existing.url === hit.url)) continue;
          if (!isRelevant(hit, input.companyName)) continue;
          hits.push(hit);
        }
      } catch (error) {
        warnings.push(`SEARCH_PROVIDER_FAILED:${provider.name}`);
        void error;
        break; // try the next provider rather than the next query
      }
      if (hits.length >= 5) break;
    }
    if (hits.length >= 3) break;
  }

  if (hits.length === 0) {
    // The honest outcome, and a common one. Not an error.
    warnings.push('NO_PUBLIC_DISCUSSION_FOUND');
    return { found: false, hits: [], notes: [], providersTried, warnings };
  }

  const notes = hits
    .slice(0, 5)
    .map((hit) => `${hit.title}${hit.snippet !== '' ? ` — ${hit.snippet.slice(0, 160)}` : ''}`);

  return { found: true, hits, notes, providersTried, warnings };
}
