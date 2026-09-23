/**
 * The public surface of the pipeline.
 *
 * `runKit` is the ONLY exported function that returns a Kit. Both the Express
 * API and the batch CLI call it, which is how "the same code your application
 * uses, not a parallel implementation" is enforced rather than merely intended.
 */
export { runKit } from './pipeline/runKit.js';
export type { RunKitInput, RunKitDeps, RunKitResult, PipelineEvent, StepId } from './pipeline/runKit.js';

export { planCategories } from './pipeline/planCategories.js';
export type { GenerationPlan, CategoryPlan } from './pipeline/planCategories.js';

// Deterministic steps. Note that neither takes a router: there is no way to
// delegate these to a model, which is the point.
export { allocateSchedule, questionCost, InvalidScheduleInput } from './schedule/allocateSchedule.js';
export { computeCoverage, shouldStopCoverageLoop, keyTerms, MAX_COVERAGE_PASSES } from './coverage/computeCoverage.js';

// LLM layer
export { LlmRouter } from './llm/router.js';
export type { CallClass, StructuredCall, StructuredResult } from './llm/router.js';
export { createGroqProvider } from './llm/providers/groq.js';
export { createFixtureProvider } from './llm/providers/fixture.js';
export { LlmError } from './llm/provider.js';
export type { LlmProvider } from './llm/provider.js';
export { DualTokenBucket, estimateTokens, parseRetryAfter, systemClock } from './llm/rateLimiter.js';
export type { Clock } from './llm/rateLimiter.js';

// Retrieval
export { createNetworkPolicy } from './net/networkPolicy.js';
export type { NetworkPolicy } from './net/networkPolicy.js';
export { fetchPage } from './net/fetchPage.js';
export type { FetchResult } from './net/fetchPage.js';
export { validateUrl, normaliseUrl, checkUrlShape } from './net/urlGuard.js';
export { crawlSite, inScope } from './crawl/crawlSite.js';
export type { CrawlResult } from './crawl/crawlSite.js';
export { extractPage, companyNameFrom } from './crawl/extract.js';
export { rankLinks, assessHiringPage, needsModelRerank } from './crawl/rankLinks.js';

// Search
export { findPublicDiscussion, createHackerNewsProvider, createBraveProvider, isBlockedDomain } from './search/findDiscussion.js';
export type { SearchProvider, SearchHit } from './search/findDiscussion.js';

// Steps, exported for the API's per-section regeneration
export { extractRequirements } from './steps/extractRequirements.js';
export { generateQuestions } from './steps/generateQuestions.js';
export { generateCompanyBrief } from './steps/companyBrief.js';
export { generateFlashcards } from './steps/generateFlashcards.js';
export type { InterviewContext } from './prompts/questionPrompts.js';
export { emptyInterviewContext } from './prompts/questionPrompts.js';
export { scanForInjection, sanitiseUntrusted, wrapUntrusted, makeNonce } from './prompts/untrusted.js';
