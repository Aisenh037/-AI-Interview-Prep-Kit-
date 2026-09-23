/**
 * Running generation as a durable job.
 *
 * The brief asks directly: "Consider what happens when it takes ninety seconds,
 * fails halfway, or is triggered twice for the same posting."
 *
 * Ninety seconds  the request returns immediately with a job id and the client
 *                 polls. Nothing long-running ever happens inside a request, so
 *                 no proxy timeout can kill it.
 * Fails halfway   the job document records per-step progress and a lease. A
 *                 sweeper reclaims jobs whose lease expired, which is what
 *                 happens when a free-tier instance sleeps mid-run. Without it a
 *                 killed process leaves a kit spinning forever, which is the
 *                 most likely "this app is broken" moment in a review.
 * Triggered twice the create route dedupes before a job is ever queued, and a
 *                 partial unique index allows only one active job per kit.
 *
 * The queue is in-process on purpose. Render's free tier has no background
 * workers, and a single instance means the queue IS the instance; adding Redis
 * would be a second service and a second secret for concurrency we do not have.
 */
import { randomUUID } from 'node:crypto';
import {
  createGroqProvider,
  createHackerNewsProvider,
  createBraveProvider,
  createNetworkPolicy,
  fetchPage,
  LlmRouter,
  runKit,
  type PipelineEvent,
  type SearchProvider,
} from '@kit/core';
import { planMerge, type MergeCandidate } from '@kit/shared';
import { env } from '../../config/env.js';
import { Job, KitItem, KitModel, type JobDoc, type KitDoc } from '../../db/models.js';
import {
  contentHashOf,
  listKeyFor,
  nextRankAfter,
  toMergeable,
  type ItemType,
} from '../kits/kits.service.js';

const INSTANCE_ID = randomUUID();

const STEPS: { id: string; label: string }[] = [
  { id: 'validate', label: 'Reading the job description' },
  { id: 'crawl', label: 'Exploring the company site' },
  { id: 'extract', label: 'Extracting requirements' },
  { id: 'discussion', label: 'Searching public discussion of their interviews' },
  { id: 'brief', label: 'Writing the company brief' },
  { id: 'plan', label: 'Deciding which question types to build' },
  { id: 'questions', label: 'Building the question bank' },
  { id: 'coverage', label: 'Checking every requirement is covered' },
  { id: 'flashcards', label: 'Making flashcards' },
  { id: 'schedule', label: 'Planning your days' },
  { id: 'assemble', label: 'Checking the kit' },
];

export function buildRouter(): LlmRouter {
  const config = env();
  const apiKey = config.GROQ_API_KEY;
  // One provider per model: the free tier meters tokens per model, so three
  // models is three independent budgets.
  return new LlmRouter(
    [
      createGroqProvider({ apiKey, model: config.LLM_MODEL, maxContextTokens: 131_072, supportsLowReasoning: false }),
      createGroqProvider({ apiKey, model: config.LLM_MODEL_OVERFLOW, maxContextTokens: 131_042, supportsLowReasoning: true }),
      createGroqProvider({ apiKey, model: config.LLM_MODEL_FAST, maxContextTokens: 131_000, supportsLowReasoning: true }),
    ],
    { defaultMaxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS },
  );
}

export function buildSearchProviders(): SearchProvider[] {
  const jsonFetch = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    return response.json();
  };
  const keyedFetch = async (
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const response = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    return response.json();
  };
  return [
    createHackerNewsProvider(jsonFetch),
    createBraveProvider(env().BRAVE_SEARCH_API_KEY, keyedFetch),
  ];
}

export function buildFetchPage(): (url: string) => ReturnType<typeof fetchPage> {
  const config = env();
  // Note the default: the SERVER refuses private addresses unless explicitly
  // told otherwise, and production ignores the variable entirely. The batch CLI
  // constructs this with the opposite default, because its fixtures are local.
  const policy = createNetworkPolicy({
    nodeEnv: config.NODE_ENV,
    allowPrivateEnv: config.ALLOW_PRIVATE_NETWORK,
    defaultAllowPrivate: false,
    extraPorts: config.PRIVATE_NETWORK_ALLOWED_PORTS.split(',')
      .map((p) => Number(p.trim()))
      .filter(Number.isFinite),
  });
  return (url: string) => fetchPage(url, { policy });
}

// ---------------------------------------------------------------------------
// The in-process queue
// ---------------------------------------------------------------------------

let running = 0;
const pending: string[] = [];

export function enqueue(jobId: string): void {
  pending.push(jobId);
  void drain();
}

async function drain(): Promise<void> {
  while (running < env().JOB_CONCURRENCY && pending.length > 0) {
    const jobId = pending.shift();
    if (jobId === undefined) break;
    running += 1;
    void execute(jobId).finally(() => {
      running -= 1;
      void drain();
    });
  }
}

async function appendEvent(jobId: string, event: Record<string, unknown>): Promise<void> {
  await Job.updateOne(
    { _id: jobId },
    {
      $push: { events: { ...event, at: new Date() } },
      $inc: { lastSeq: 1 },
      $set: { heartbeatAt: new Date() },
    },
  );
}

async function execute(jobId: string): Promise<void> {
  // Atomic claim, so two instances could never run the same job twice.
  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: 'queued' },
    {
      $set: {
        status: 'running',
        leaseOwner: INSTANCE_ID,
        leaseExpiresAt: new Date(Date.now() + env().JOB_LEASE_MS),
        heartbeatAt: new Date(),
        startedAt: new Date(),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  if (job === null) return; // someone else claimed it

  const heartbeat = setInterval(() => {
    void Job.updateOne(
      { _id: jobId },
      { $set: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + env().JOB_LEASE_MS) } },
    );
  }, 15_000);

  try {
    if (job.kind === 'regenerate') await runRegeneration(job);
    else await runGeneration(job);
  } catch (error) {
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'failed',
          error: { code: 'INTERNAL', message: (error as Error).message },
          finishedAt: new Date(),
        },
        $unset: { active: '' },
      },
    );
    await KitModel.updateOne({ _id: job.kitId }, { $set: { status: 'failed' } });
  } finally {
    clearInterval(heartbeat);
  }
}

async function runGeneration(job: JobDoc): Promise<void> {
  const kit = await KitModel.findById(job.kitId);
  if (kit === null) throw new Error('kit disappeared');

  await KitModel.updateOne({ _id: kit._id }, { $set: { status: 'generating' } });
  await Job.updateOne({ _id: job._id }, { $set: { steps: STEPS.map((s) => ({ ...s, status: 'pending' })) } });

  const onEvent = (event: PipelineEvent): void => {
    void (async () => {
      if (event.type === 'step:start' && event.step !== undefined) {
        const index = STEPS.findIndex((s) => s.id === event.step);
        await Job.updateOne(
          { _id: job._id },
          {
            $set: {
              [`steps.${index}.status`]: 'running',
              progress: Math.round((index / STEPS.length) * 100),
              heartbeatAt: new Date(),
            },
          },
        );
      } else if (event.type === 'step:done' && event.step !== undefined) {
        const index = STEPS.findIndex((s) => s.id === event.step);
        await Job.updateOne(
          { _id: job._id },
          { $set: { [`steps.${index}.status`]: 'ok', heartbeatAt: new Date() } },
        );
      } else if (event.type === 'note' && event.message !== undefined) {
        await appendEvent(String(job._id), { type: 'note', message: event.message });
      }
    })();
  };

  const result = await runKit(
    { id: String(kit._id), jd: kit.input.jd, company_url: kit.input.companyUrl, days: kit.input.days },
    {
      router: buildRouter(),
      fetchPage: buildFetchPage(),
      searchProviders: buildSearchProviders(),
      onEvent,
      deadline: Date.now() + env().GENERATION_BUDGET_MS,
    },
  );

  if (result.status === 'failed' || result.kit === null) {
    await Job.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', error: result.error, finishedAt: new Date() }, $unset: { active: '' } },
    );
    await KitModel.updateOne({ _id: kit._id }, { $set: { status: 'failed', warnings: result.warnings } });
    return;
  }

  await materialise(kit, result.kit, String(job._id));

  await KitModel.updateOne(
    { _id: kit._id },
    {
      $set: {
        // "partial" is not failure: it means the kit is usable but research was
        // incomplete, and the UI shows those gaps rather than hiding them.
        status: result.warnings.some((w) => w.includes('UNREACHABLE') || w.includes('NO_HIRING_PAGE'))
          ? 'partial'
          : 'ready',
        kit: result.kit,
        research: result.research,
        warnings: result.warnings,
        title: `${result.kit.role.title || 'Untitled role'} at ${result.kit.source.company}`,
      },
      $inc: { version: 1 },
    },
  );

  await Job.updateOne(
    { _id: job._id },
    { $set: { status: 'succeeded', progress: 100, finishedAt: new Date() }, $unset: { active: '' } },
  );
}

/** Write the generated kit out as individual items, so the builder can edit them. */
async function materialise(
  kit: KitDoc,
  produced: import('@kit/shared').Kit,
  runId: string,
): Promise<void> {
  const docs: Record<string, unknown>[] = [];
  const push = (type: ItemType, publicId: string, listKey: string, rank: string, data: unknown): void => {
    docs.push({
      kitId: kit._id,
      userId: kit.userId,
      publicId,
      type,
      listKey,
      rank,
      status: 'active',
      version: 1,
      createdBy: 'ai',
      lastEditedBy: 'ai',
      editedFields: [],
      pinned: false,
      movedByUser: false,
      contentHash: contentHashOf(data),
      introducedByRunId: runId,
      data,
    });
  };

  let rank: string | null = null;
  for (const requirement of produced.role.requirements) {
    rank = nextRankAfter(rank);
    push('requirement', requirement.id, 'requirements', rank, requirement);
  }

  const perCategory = new Map<string, string | null>();
  for (const question of produced.questions) {
    const listKey = listKeyFor('question', question.category);
    const last = perCategory.get(listKey) ?? null;
    const next = nextRankAfter(last);
    perCategory.set(listKey, next);
    push('question', question.id, listKey, next, question);
  }

  let cardRank: string | null = null;
  for (const card of produced.flashcards) {
    cardRank = nextRankAfter(cardRank);
    push('flashcard', card.id, 'flashcards', cardRank, card);
  }

  await KitItem.deleteMany({ kitId: kit._id });
  if (docs.length > 0) await KitItem.insertMany(docs);

  await KitModel.updateOne(
    { _id: kit._id },
    {
      $set: {
        'nextIds.r': produced.role.requirements.length + 1,
        'nextIds.q': produced.questions.length + 1,
        'nextIds.f': produced.flashcards.length + 1,
      },
    },
  );
}

/**
 * Regenerate one section, merging against LIVE state at commit time.
 *
 * The snapshot the job started from is deliberately not used for the decision:
 * an edit that landed while the model was thinking must be visible here, or it
 * would be overwritten by a run that never saw it.
 */
async function runRegeneration(job: JobDoc): Promise<void> {
  const { regenerateSection } = await import('./regenerate.js');
  await regenerateSection(String(job._id), String(job.kitId), String(job.sectionKey ?? ''));
}

// ---------------------------------------------------------------------------
// Recovering orphaned jobs
// ---------------------------------------------------------------------------

/**
 * Reclaim jobs whose lease expired.
 *
 * This is what makes a sleeping free-tier instance survivable: the process is
 * killed mid-run, the lease lapses, and the next boot requeues the job instead
 * of leaving a kit that spins forever.
 */
export async function sweepStalledJobs(): Promise<number> {
  const expired = await Job.find({
    status: 'running',
    leaseExpiresAt: { $lt: new Date() },
  }).limit(20);

  let reclaimed = 0;
  for (const job of expired) {
    if (job.attempts < 3) {
      await Job.updateOne(
        { _id: job._id, status: 'running' },
        { $set: { status: 'queued', leaseOwner: null, leaseExpiresAt: null } },
      );
      enqueue(String(job._id));
      reclaimed += 1;
    } else {
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'stalled',
            error: { code: 'JOB_ABANDONED', message: 'Generation stopped unexpectedly.' },
            finishedAt: new Date(),
          },
          $unset: { active: '' },
        },
      );
      await KitModel.updateOne({ _id: job.kitId }, { $set: { status: 'failed' } });
    }
  }
  return reclaimed;
}

export function startSweeper(): NodeJS.Timeout {
  void sweepStalledJobs();
  return setInterval(() => void sweepStalledJobs(), 60_000);
}

export { planMerge, type MergeCandidate };
