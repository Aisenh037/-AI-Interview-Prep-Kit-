/**
 * The whole pipeline, in one ordered function.
 *
 * This is the only exported path that produces a Kit. The Express API calls it
 * and the batch CLI calls it — "the same code your application uses, not a
 * parallel implementation" is a requirement, and having a single entry point is
 * how that is enforced rather than promised.
 *
 * The ordering is not decorative. Pasted text needs no retrieval, so extraction
 * starts immediately and runs alongside the crawl. The company site must be
 * crawled before it is useful, so the brief waits for it. And `planCategories`
 * sits between research and generation precisely so that what was found changes
 * what gets generated.
 *
 * Two steps never touch a model, by construction: coverage checking and schedule
 * allocation. Neither function takes a router, so there is no way to delegate
 * them even by accident.
 */
import type { Kit } from '@kit/shared';
import { validateKit } from '@kit/shared';
import type { LlmRouter } from '../llm/router.js';
import type { FetchResult } from '../net/fetchPage.js';
import { crawlSite, type CrawlResult } from '../crawl/crawlSite.js';
import { companyNameFrom } from '../crawl/extract.js';
import { extractRequirements } from '../steps/extractRequirements.js';
import { generateCompanyBrief } from '../steps/companyBrief.js';
import { generateQuestions } from '../steps/generateQuestions.js';
import { generateFlashcards } from '../steps/generateFlashcards.js';
import { allocateSchedule } from '../schedule/allocateSchedule.js';
import { computeCoverage } from '../coverage/computeCoverage.js';
import { planCategories } from './planCategories.js';
import { emptyInterviewContext, type InterviewContext } from '../prompts/questionPrompts.js';
import { findPublicDiscussion, type SearchProvider } from '../search/findDiscussion.js';
import { makeNonce, scanForInjection } from '../prompts/untrusted.js';
import { systemClock, type Clock } from '../llm/rateLimiter.js';

export type StepId =
  | 'validate'
  | 'crawl'
  | 'extract'
  | 'discussion'
  | 'brief'
  | 'plan'
  | 'questions'
  | 'coverage'
  | 'flashcards'
  | 'schedule'
  | 'assemble';

export interface PipelineEvent {
  type: 'step:start' | 'step:done' | 'step:degraded' | 'note';
  step?: StepId;
  message?: string;
  detail?: unknown;
}

export interface RunKitInput {
  id?: string;
  jd: string;
  company_url: string;
  days: number;
}

export interface RunKitDeps {
  router: LlmRouter;
  fetchPage: (url: string) => Promise<FetchResult>;
  searchProviders?: SearchProvider[];
  clock?: Clock;
  onEvent?: (event: PipelineEvent) => void;
  signal?: AbortSignal;
  /** Wall-clock deadline for the whole run. */
  deadline?: number;
  /** Timestamp used for `researched_at`, injected so runs are reproducible. */
  nowIso?: () => string;
}

export interface RunKitResult {
  status: 'ok' | 'failed';
  kit: Kit | null;
  error: { code: string; message: string } | null;
  warnings: string[];
  research: {
    pagesFetched: number;
    hiringPageFound: boolean;
    hiringPageUrl: string | null;
    discussionFound: boolean;
    rationale: string[];
    attempts: CrawlResult['attempts'];
  };
  timings: Record<string, number>;
}

const MAX_DAYS = 365;

export async function runKit(input: RunKitInput, deps: RunKitDeps): Promise<RunKitResult> {
  const clock = deps.clock ?? systemClock;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  const emit = (event: PipelineEvent): void => deps.onEvent?.(event);

  const time = async <T>(step: StepId, fn: () => Promise<T>): Promise<T> => {
    emit({ type: 'step:start', step });
    const started = clock.now();
    try {
      return await fn();
    } finally {
      timings[step] = clock.now() - started;
      emit({ type: 'step:done', step });
    }
  };

  // --- step 0: validate -----------------------------------------------------
  const jd = (input.jd ?? '').trim();
  const days = Math.trunc(input.days);
  if (jd === '') {
    return failure('INVALID_CASE', 'the job description is empty', warnings, timings);
  }
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
    return failure('INVALID_CASE', `days must be between 1 and ${MAX_DAYS}`, warnings, timings);
  }

  const nonce = makeNonce(`${input.id ?? ''}${jd.slice(0, 120)}`);

  const injection = scanForInjection(jd);
  if (injection.suspicious) {
    // Surfaced rather than silently dropped: "we ignored instructions found in
    // this text" is useful information for the person who pasted it.
    warnings.push('SUSPECTED_PROMPT_INJECTION:job-description');
    emit({ type: 'note', message: 'Suspicious instructions in the job description were ignored.' });
  }

  // --- steps 1: extraction and crawling, in parallel ------------------------
  // The pasted description needs no retrieval, so it does not wait for the site.
  const [role, crawl] = await Promise.all([
    time('extract', () =>
      extractRequirements({
        jd,
        router: deps.router,
        ...(deps.deadline !== undefined ? { deadline: deps.deadline } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      }),
    ),
    time('crawl', () =>
      crawlSite(input.company_url, {
        fetchPage: deps.fetchPage,
        clock,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      }).catch(
        (): CrawlResult => ({
          root: null,
          pages: [],
          aboutPage: null,
          hiringPage: null,
          hiringConfidence: 'none',
          hiringSignals: { systemDesign: false, takeHome: false, pairing: false, values: false },
          stageTerms: [],
          attempts: [],
          warnings: ['COMPANY_SITE_UNREACHABLE'],
          pagesUsed: [],
        }),
      ),
    ),
  ]);

  warnings.push(...role.warnings, ...crawl.warnings);

  const companyName =
    crawl.root !== null ? companyNameFrom(crawl.root, input.company_url) : hostLabel(input.company_url);

  // Pages that try to give the model instructions are excluded from context.
  const safePages = crawl.pages.filter((page) => {
    if (!scanForInjection(page.text).suspicious) return true;
    warnings.push(`SUSPECTED_PROMPT_INJECTION:${page.url}`);
    emit({ type: 'note', message: `Ignored suspicious instructions found on ${page.url}.` });
    return false;
  });

  // --- step 2: public discussion -------------------------------------------
  const discussion = await time('discussion', async () => {
    if (deps.searchProviders === undefined || deps.searchProviders.length === 0) {
      return { found: false, hits: [], notes: [], providersTried: [], warnings: ['SEARCH_UNAVAILABLE'] };
    }
    return findPublicDiscussion({
      companyName,
      roleTitle: role.title,
      providers: deps.searchProviders,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
  });
  warnings.push(...discussion.warnings);

  // --- step 3: the company brief -------------------------------------------
  const briefResult = await time('brief', () =>
    generateCompanyBrief({
      companyName,
      companyUrl: input.company_url,
      pages: safePages,
      discussion: discussion.notes,
      attemptedCount: crawl.attempts.length,
      nonce,
      router: deps.router,
      ...(deps.deadline !== undefined ? { deadline: deps.deadline } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    }),
  );
  warnings.push(...briefResult.warnings);

  // --- step 4: the deterministic fork --------------------------------------
  const context: InterviewContext = {
    ...emptyInterviewContext(companyName),
    found: crawl.hiringPage !== null || discussion.found,
    confidence: crawl.hiringConfidence,
    stages: crawl.stageTerms,
    signals: crawl.hiringSignals,
    values: briefResult.values,
    companyName,
    discussion: discussion.notes,
  };

  const plan = await time('plan', async () =>
    planCategories(role.requirements, context, role.seniority),
  );
  for (const line of plan.rationale) emit({ type: 'note', message: line });

  // --- step 5: questions, with the coverage loop ---------------------------
  const generated = await time('questions', () =>
    generateQuestions({
      plan,
      requirements: role.requirements,
      context,
      roleTitle: role.title,
      seniority: role.seniority,
      nonce,
      router: deps.router,
      ...(deps.deadline !== undefined ? { deadline: deps.deadline } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    }),
  );
  warnings.push(...generated.warnings);

  // --- step 6: flashcards ---------------------------------------------------
  const cards = await time('flashcards', () =>
    generateFlashcards({
      requirements: role.requirements,
      questions: generated.questions,
      roleTitle: role.title,
      nonce,
      router: deps.router,
      ...(deps.deadline !== undefined ? { deadline: deps.deadline } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    }),
  );
  warnings.push(...cards.warnings);

  // --- step 7: the schedule, arithmetic only -------------------------------
  const scheduleResult = await time('schedule', async () =>
    allocateSchedule({
      questions: generated.questions,
      requirements: role.requirements,
      days,
      signals: { systemDesign: context.signals.systemDesign, takeHome: context.signals.takeHome },
    }),
  );
  warnings.push(...scheduleResult.warnings);

  // --- step 8: assemble and validate ---------------------------------------
  const finalCoverage = computeCoverage(role.requirements, generated.questions);

  const kit: Kit = {
    source: {
      company: companyName,
      company_url: input.company_url,
      role: role.title,
      location: role.location,
      jd_chars: jd.length,
      researched_at: nowIso(),
      // Only pages we actually fetched. An injected URL cannot appear here.
      pages_used: crawl.pagesUsed,
    },
    company_brief: briefResult.brief,
    role: {
      title: role.title,
      seniority: role.seniority,
      responsibilities: role.responsibilities,
      requirements: role.requirements,
    },
    questions: generated.questions,
    flashcards: cards.flashcards,
    schedule: scheduleResult.schedule,
    coverage: {
      uncovered_requirement_ids: finalCoverage.uncovered,
      passes: generated.passes,
    },
  };

  const validation = await time('assemble', async () => validateKit(kit));
  if (!validation.ok) {
    return {
      status: 'failed',
      kit: null,
      error: {
        code: 'SCHEMA_INVALID',
        message: validation.issues
          .slice(0, 3)
          .map((i) => `${i.path}: ${i.message}`)
          .join('; '),
      },
      warnings,
      research: researchSummary(crawl, discussion.found, plan.rationale),
      timings,
    };
  }

  return {
    status: 'ok',
    kit: validation.kit,
    error: null,
    warnings: dedupe(warnings),
    research: researchSummary(crawl, discussion.found, plan.rationale),
    timings,
  };
}

function researchSummary(
  crawl: CrawlResult,
  discussionFound: boolean,
  rationale: string[],
): RunKitResult['research'] {
  return {
    pagesFetched: crawl.pages.length,
    hiringPageFound: crawl.hiringPage !== null,
    hiringPageUrl: crawl.hiringPage?.url ?? null,
    discussionFound,
    rationale,
    attempts: crawl.attempts,
  };
}

function failure(
  code: string,
  message: string,
  warnings: string[],
  timings: Record<string, number>,
): RunKitResult {
  return {
    status: 'failed',
    kit: null,
    error: { code, message },
    warnings,
    research: {
      pagesFetched: 0,
      hiringPageFound: false,
      hiringPageUrl: null,
      discussionFound: false,
      rationale: [],
      attempts: [],
    },
    timings,
  };
}

/**
 * A last-resort company name, used only when no page could be read.
 *
 * Locally-served sites need care: the batch harness may serve several companies
 * from one host, so the hostname is "localhost" and carries no information while
 * the first path segment ("/acme/") is the actual company. Falling back to the
 * hostname there would put "Localhost" in a graded kit.
 */
function hostLabel(url: string): string {
  const titleCase = (value: string): string =>
    value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const isLocal = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === '::1';
    if (isLocal) {
      const segment = parsed.pathname.split('/').filter(Boolean)[0];
      if (segment !== undefined && segment !== '') return titleCase(segment);
      return 'this company';
    }
    return titleCase(host.split('.')[0] ?? host);
  } catch {
    return 'this company';
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
