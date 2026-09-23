/**
 * The LLM router.
 *
 * Two jobs, both of them consequences of measurement rather than taste.
 *
 * 1. SPREAD LOAD ACROSS MODELS TO MULTIPLY THE TOKEN BUDGET.
 *    The free tier allows 8,000 tokens/minute, and the fifteen-minute budget for
 *    five cases does not comfortably fit inside that. But the limit is enforced
 *    PER MODEL — three models were observed reporting independent
 *    `x-ratelimit-remaining-tokens` counters — so running a bucket per model
 *    turns 8K tokens/minute into roughly 24K. That is the difference between
 *    finishing the batch run and timing out.
 *
 * 2. GUARANTEE A KIT IS ALWAYS PRODUCIBLE.
 *    `callStructured` takes `fallback` as a REQUIRED argument. There is no
 *    overload without it. You cannot write a pipeline step that has no
 *    deterministic path, because the type checker will not let you — which is a
 *    stronger guarantee than a convention everyone agrees to follow.
 *
 * Calls are also routed by shape: quality-critical work prefers the larger model,
 * mechanical work (re-ranking links, filling one gap, repairing JSON) prefers the
 * small fast one. That is not only cheaper, it keeps the large model's bucket
 * free for the calls that actually need it.
 */
import { z } from 'zod';
import { DualTokenBucket, estimateTokens, systemClock, type Clock } from './rateLimiter.js';
import { LlmError, type LlmProvider } from './provider.js';
import { parseModelJson } from './jsonRepair.js';

export type CallClass =
  | 'extract'
  | 'brief'
  | 'questions'
  | 'flashcards'
  | 'rerank'
  | 'gapfill'
  | 'repair';

/** Work that deserves the best model available. */
const QUALITY_CLASSES = new Set<CallClass>(['extract', 'brief', 'questions', 'flashcards']);

const MAX_ATTEMPTS_PER_PROVIDER = 3;
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 20_000;

interface Route {
  provider: LlmProvider;
  bucket: DualTokenBucket;
  consecutiveFailures: number;
  openUntil: number;
}

export interface StructuredCall<T> {
  callClass: CallClass;
  system: string;
  user: string;
  /** Validates and types the model's output. */
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
  /**
   * The deterministic result used when the model cannot be reached, cannot be
   * parsed, or cannot satisfy the schema. Required, deliberately.
   */
  fallback: () => T;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface StructuredResult<T> {
  value: T;
  /** Whether a model produced this, or the deterministic path did. */
  origin: 'model' | 'fallback';
  warnings: string[];
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

export interface LlmRouterOptions {
  clock?: Clock;
  defaultMaxOutputTokens?: number;
  onWarn?: (message: string) => void;
  /**
   * Source of jitter, injected so retry timing is reproducible in tests.
   * `core` never calls Math.random directly — determinism is a property we test.
   */
  random?: () => number;
}

export class LlmRouter {
  private readonly routes: Route[];
  private readonly clock: Clock;
  private readonly defaultMaxOutputTokens: number;
  private readonly onWarn: ((message: string) => void) | undefined;
  private readonly random: () => number;

  constructor(providers: LlmProvider[], options: LlmRouterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4000;
    this.onWarn = options.onWarn;
    this.random = options.random ?? Math.random;
    this.routes = providers.map((provider) => ({
      provider,
      // One bucket per model, because the provider meters per model.
      bucket: new DualTokenBucket({
        rpm: provider.limits.rpm,
        tpm: provider.limits.tpm,
        clock: this.clock,
        name: `${provider.name}:${provider.model}`,
      }),
      consecutiveFailures: 0,
      openUntil: 0,
    }));
  }

  get providerCount(): number {
    return this.routes.length;
  }

  /** Aggregate tokens per minute across every bucket — the real ceiling. */
  get aggregateTpm(): number {
    return this.routes.reduce((sum, r) => sum + r.provider.limits.tpm, 0);
  }

  private order(callClass: CallClass): Route[] {
    const wantsQuality = QUALITY_CLASSES.has(callClass);
    // Larger context implies the bigger model here; good enough as a proxy and
    // avoids hard-coding model names into routing.
    const byCapability = [...this.routes].sort(
      (a, b) => b.provider.limits.maxContextTokens - a.provider.limits.maxContextTokens,
    );
    const preferred = wantsQuality ? byCapability : [...byCapability].reverse();

    const now = this.clock.now();
    const available = preferred.filter((r) => r.openUntil <= now);
    const tripped = preferred.filter((r) => r.openUntil > now);
    // A tripped breaker is a last resort, not a permanent exclusion.
    return [...available, ...tripped];
  }

  async callStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const warnings: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const maxOutputTokens = call.maxOutputTokens ?? this.defaultMaxOutputTokens;
    const jsonSchema = {
      name: call.schemaName,
      schema: toJsonSchema(call.schema),
    };

    for (const route of this.order(call.callClass)) {
      const { provider, bucket } = route;

      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
        if (call.signal?.aborted === true) break;
        if (call.deadline !== undefined && this.clock.now() > call.deadline) break;

        // `low` is only safe where it does not break structured output.
        const reasoningEffort =
          !QUALITY_CLASSES.has(call.callClass) && provider.limits.supportsLowReasoning
            ? ('low' as const)
            : undefined;

        const estimate = estimateTokens(call.system + call.user, maxOutputTokens);
        let reservation;
        try {
          reservation = await bucket.reserve(estimate, {
            ...(call.deadline !== undefined ? { deadline: call.deadline } : {}),
            ...(call.signal !== undefined ? { signal: call.signal } : {}),
          });
        } catch (error) {
          // Too large for this bucket, or waiting would pass the deadline.
          warnings.push(`${provider.model}: ${(error as Error).message}`);
          break; // try the next provider rather than burning attempts here
        }

        try {
          const response = await provider.complete({
            system: call.system,
            user: call.user,
            jsonSchema,
            maxOutputTokens,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            ...(call.signal !== undefined ? { signal: call.signal } : {}),
          });

          const total = response.usage.inputTokens + response.usage.outputTokens;
          reservation.settle(total);
          bucket.syncFromHeaders(response.rateLimit);
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
          usage.calls += 1;

          const parsed = parseModelJson(response.text);
          if (!parsed.ok) {
            route.consecutiveFailures += 1;
            warnings.push(`${provider.model}: output was not usable JSON`);
            continue;
          }
          if (parsed.rung !== 'direct') {
            warnings.push(`LLM_OUTPUT_REPAIRED:${parsed.rung}`);
          }

          const validated = call.schema.safeParse(parsed.value);
          if (!validated.success) {
            route.consecutiveFailures += 1;
            warnings.push(
              `${provider.model}: output failed validation — ${validated.error.issues[0]?.message ?? 'unknown'}`,
            );
            continue;
          }

          route.consecutiveFailures = 0;
          return { value: validated.data, origin: 'model', warnings, usage };
        } catch (error) {
          reservation.cancel();
          const llmError =
            error instanceof LlmError
              ? error
              : new LlmError({
                  code: 'NETWORK',
                  message: (error as Error).message,
                  provider: provider.name,
                  model: provider.model,
                });

          route.consecutiveFailures += 1;
          if (route.consecutiveFailures >= BREAKER_THRESHOLD) {
            route.openUntil = this.clock.now() + BREAKER_COOLDOWN_MS;
            this.onWarn?.(`${provider.model} circuit opened after repeated failures`);
          }

          if (llmError.code === 'RATE_LIMIT') {
            // The quota is shared, so one caller's refusal is everyone's news.
            bucket.penalise(llmError.retryAfterMs ?? 2000);
          }

          warnings.push(`${provider.model}: ${llmError.code}`);

          if (!llmError.retryable) break; // auth or bad request: move to the next provider
          const backoff = llmError.retryAfterMs ?? Math.min(8000, 400 * 2 ** attempt);
          // Full jitter, so concurrent callers do not resynchronise on retry.
          const jittered = Math.floor(backoff * (0.5 + this.random() / 2));
          try {
            await this.clock.sleep(jittered, call.signal);
          } catch {
            break;
          }
        }
      }
    }

    warnings.push(`FALLBACK_USED:${call.callClass}`);
    return { value: call.fallback(), origin: 'fallback', warnings, usage };
  }
}

/** zod 4 emits JSON Schema natively; the provider layer hardens it for strict mode. */
function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema as never) as Record<string, unknown>;
}
