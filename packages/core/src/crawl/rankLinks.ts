/**
 * Ranking links to find how a company describes its hiring.
 *
 * The brief calls this "the interesting half", and is specific about why a path
 * list will not do: "Companies bury it in different places — /careers, /jobs, a
 * handbook, an engineering blog — and the path cannot be hard-coded. When we
 * tested this we guessed one company URL and got a 404, while GitLab and PostHog
 * both publish detailed hiring processes at paths we would never have predicted.
 * Crawl the site, rank the links, fetch what looks right."
 *
 * So scoring runs over three independent signals, none of which is a path list:
 *
 *   VOCABULARY  tiered phrases matched against anchor text and path segments.
 *               An exact phrase as a whole path segment (/how-we-hire) scores
 *               far above the same word appearing incidentally.
 *   PLACEMENT   a link in site-wide chrome is canonical. Companies link their
 *               careers page from every footer; they link a blog post once.
 *   CORROBORATION a URL that appears on several crawled pages, or in the
 *               sitemap, is structural rather than incidental.
 *
 * GitLab's /handbook/hiring/ scores on `handbook` + `hiring` + chrome placement.
 * PostHog's /handbook/people/hiring-process/ hits the top tier on a whole
 * segment. Neither is /careers, and neither needs to be known in advance.
 */

/** Phrases that describe the process itself — the thing we most want to find. */
const TIER_PROCESS = [
  'interview process', 'how we hire', 'hiring process', 'what to expect',
  'interviewing at', 'recruitment process', 'take home', 'take-home',
  'candidate guide', 'hiring handbook', 'our process', 'how we interview',
  'interview guide', 'assessment process', 'what our interviews look like',
];

/** Phrases that describe working there — usually one click from the process. */
const TIER_CAREERS = [
  // Inflections are matched automatically, so `join` covers "Joining us" and
  // `hire` covers "Hiring". Entries here stay in their base form to avoid
  // counting the same evidence twice.
  'career', 'job', 'join', 'hire', 'recruit', 'employment', 'vacancy',
  'vacancies', 'opportunity', 'opportunities', 'opening', 'handbook', 'talent',
  'work with us', 'open roles', 'life at', 'working at', 'work here', 'people ops',
];

/** Phrases that describe the company — needed for the brief, not the process. */
const TIER_ABOUT = [
  'about', 'about us', 'company', 'mission', 'who we are', 'what we do',
  'values', 'culture', 'team', 'our story', 'engineering blog',
];

/** Pages that are never what we are looking for. */
const TIER_NOISE = [
  'privacy', 'terms', 'cookie', 'legal', 'login', 'log in', 'sign in', 'sign up',
  'pricing', 'contact sales', 'press', 'investors', 'status', 'security',
  'docs', 'documentation', 'api reference', 'download', 'cart', 'checkout',
  'unsubscribe', 'sitemap', 'rss',
];

const WEIGHTS = { process: 6, careers: 3, about: 1.5, noise: -4 } as const;

export type RankProfile = 'hiring' | 'about';

export interface RankableLink {
  url: string;
  anchor: string;
  inChrome: boolean;
  context: string;
  depth: number;
}

export interface RankedLink extends RankableLink {
  score: number;
  /** 0..1, used to decide whether the heuristic was confident enough. */
  confidence: number;
  features: Record<string, number>;
}

export interface RankOptions {
  profile?: RankProfile;
  /** URLs discovered in sitemap.xml — structural corroboration. */
  sitemapUrls?: ReadonlySet<string>;
  /** How many already-crawled pages linked to each URL. */
  inboundCounts?: ReadonlyMap<string, number>;
}

const MAX_SCORE = 20;

/** Split a URL path into comparable words: /how-we-hire -> ["how","we","hire"]. */
function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function segmentWords(segment: string): string {
  return segment.replace(/[-_.]+/g, ' ').replace(/\.(html?|php|aspx)$/i, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a lexicon entry against text.
 *
 * Multi-word phrases match as substrings. Single words match on a word boundary
 * with common inflections, so `join` finds "Joining us", `hire` finds "Hiring"
 * and `career` finds "Careers".
 *
 * That inflection rule is not cosmetic. A fixture footer reading "Joining us"
 * scored zero against a literal "join us" entry and lost to the about page —
 * exactly the kind of near-miss that makes a hiring page undiscoverable when the
 * wording is a shade different from the lexicon.
 */
function matchesPhrase(haystack: string, phrase: string): boolean {
  if (phrase.includes(' ')) return haystack.includes(phrase);
  const escaped = escapeRegExp(phrase);
  // English drops a trailing silent `e` before `-ing`/`-ed`. Without this rule
  // `hire` + `ing` is "hireing", so "Hiring" — the single most important word in
  // the careers lexicon — matched nothing at all.
  const stem = phrase.endsWith('e') ? escapeRegExp(phrase.slice(0, -1)) : escaped;
  const pattern = new RegExp(`\\b(?:${escaped}(?:s|es|ed|ment)?|${stem}(?:ing|ed))\\b`);
  return pattern.test(haystack);
}

/**
 * How many distinct lexicon entries a text matches, capped.
 *
 * The cap matters: overlapping entries would otherwise stack. "Joining us"
 * matched `join`, `joining` and `join us` as three separate hits and outscored a
 * page that was plainly a better answer. A text either speaks this vocabulary or
 * it does not; five synonyms are not five times the evidence.
 */
const MAX_TIER_HITS = 2;

function countPhrases(haystack: string, phrases: string[]): number {
  let hits = 0;
  for (const phrase of phrases) {
    if (matchesPhrase(haystack, phrase)) {
      hits += 1;
      if (hits >= MAX_TIER_HITS) break;
    }
  }
  return hits;
}

/** A single job advert is not the hiring process; we want the description of it. */
function looksLikeSingleJobPosting(url: string): boolean {
  if (/[?&](gh_jid|lever-|ashby_jid|job_id)=/i.test(url)) return true;
  const segments = pathSegments(url);
  const last = segments.at(-1) ?? '';
  // /jobs/12345 or /careers/senior-backend-engineer-1a2b3c
  if (/^\d{3,}$/.test(last)) return true;
  if (/-[0-9a-f]{6,}$/i.test(last)) return true;
  return false;
}

const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'teamtailor.com'];

export function scoreLink(link: RankableLink, options: RankOptions = {}): RankedLink {
  const profile = options.profile ?? 'hiring';
  const anchor = link.anchor.toLowerCase();
  const segments = pathSegments(link.url).map(segmentWords);
  const pathText = segments.join(' ');
  const context = link.context.toLowerCase();

  // The `about` profile reuses the same machinery with the tiers re-weighted,
  // rather than duplicating the scorer.
  const w =
    profile === 'hiring'
      ? WEIGHTS
      : { process: 1.5, careers: 1.5, about: 6, noise: WEIGHTS.noise };

  const features: Record<string, number> = {};

  features['anchorProcess'] = countPhrases(anchor, TIER_PROCESS) * w.process;
  features['anchorCareers'] = countPhrases(anchor, TIER_CAREERS) * w.careers;
  features['anchorAbout'] = countPhrases(anchor, TIER_ABOUT) * w.about;
  features['anchorNoise'] = countPhrases(anchor, TIER_NOISE) * w.noise;

  features['pathProcess'] = countPhrases(pathText, TIER_PROCESS) * w.process * 0.8;
  features['pathCareers'] = countPhrases(pathText, TIER_CAREERS) * w.careers * 0.8;
  features['pathAbout'] = countPhrases(pathText, TIER_ABOUT) * w.about * 0.8;
  features['pathNoise'] = countPhrases(pathText, TIER_NOISE) * w.noise;

  // A phrase occupying a whole path segment is a much stronger signal than the
  // same words appearing somewhere in a long URL.
  const wholeSegment = segments.some((segment) =>
    (profile === 'hiring' ? TIER_PROCESS : TIER_ABOUT).includes(segment),
  );
  features['wholeSegment'] = wholeSegment ? 2 : 0;

  features['chrome'] = link.inChrome ? 2 : 0;
  features['context'] = countPhrases(context, TIER_PROCESS) > 0 ? 1.5 : 0;

  const inbound = options.inboundCounts?.get(link.url) ?? 0;
  features['corroborated'] = inbound >= 2 ? 1 : 0;
  features['sitemap'] = options.sitemapUrls?.has(link.url) === true ? 2 : 0;

  // Mild: GitLab's handbook is genuinely several levels deep.
  features['depth'] = Math.max(-2, -0.75 * Math.max(0, link.depth - 2));

  features['singleJob'] = looksLikeSingleJobPosting(link.url) ? -8 : 0;
  features['ats'] = ATS_HOSTS.some((host) => link.url.includes(host)) ? 5 : 0;

  const raw = Object.values(features).reduce((sum, v) => sum + v, 0);
  const score = Math.max(-5, Math.min(MAX_SCORE, raw));

  return { ...link, score, confidence: Math.max(0, score) / MAX_SCORE, features };
}

export function rankLinks(links: RankableLink[], options: RankOptions = {}): RankedLink[] {
  return links
    .map((link) => scoreLink(link, options))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

/**
 * Should we spend a model call re-ranking?
 *
 * Only when the heuristic is genuinely unsure, because that is the only case
 * where a model beats keywords — a link reading "Handbook → People Ops" has no
 * hiring vocabulary in its anchor at all. When the top candidate is clear, the
 * call is skipped and the budget goes to generation instead.
 */
export function needsModelRerank(ranked: RankedLink[]): boolean {
  const top = ranked[0];
  if (top === undefined) return false;
  if (top.confidence < 0.55) return true;
  const third = ranked[2];
  if (third !== undefined && top.score - third.score < 0.1 * MAX_SCORE) return true;
  return false;
}

/** Vocabulary that indicates a page is DESCRIBING a process, not just mentioning one. */
const STAGE_WORDS =
  /\b(round|stage|screen(?:ing)?|take[- ]home|onsite|on-site|system design|pair(?:ing)?|panel|recruiter (?:screen|call)|technical interview|culture (?:fit|interview)|values interview|offer|hiring manager|phone screen|final interview)\b/gi;
const ORDINALS = /(?:^|\n)\s*(?:step\s*\d|stage\s*\d|\d[.)]\s|first\b.*\bthen\b)/gim;

export type HiringPageConfidence = 'confident' | 'weak' | 'none';

export interface HiringPageAssessment {
  confidence: HiringPageConfidence;
  stageTerms: string[];
  signals: { systemDesign: boolean; takeHome: boolean; pairing: boolean; values: boolean };
}

/**
 * Decide from the fetched TEXT whether a page really describes a hiring process.
 * Deterministic on purpose: this sets the flags that change which question
 * categories get generated, so it needs to be inspectable and reproducible.
 */
export function assessHiringPage(text: string): HiringPageAssessment {
  const matches = text.match(STAGE_WORDS) ?? [];
  const distinct = [...new Set(matches.map((m) => m.toLowerCase()))];
  const ordinalHits = (text.match(ORDINALS) ?? []).length;
  const listy = (text.match(/\n- /g) ?? []).length >= 3;

  const lower = text.toLowerCase();
  const signals = {
    systemDesign: /system design|architecture interview|design round/.test(lower),
    takeHome: /take[- ]home|home assignment|coding exercise|written exercise/.test(lower),
    pairing: /pair(ing)? (programming|exercise|interview)|live coding/.test(lower),
    values: /values interview|culture (fit|interview)|our values/.test(lower),
  };

  let confidence: HiringPageConfidence = 'none';
  if (distinct.length >= 4 && (ordinalHits >= 2 || listy)) confidence = 'confident';
  else if (distinct.length >= 2) confidence = 'weak';

  return { confidence, stageTerms: distinct, signals };
}
