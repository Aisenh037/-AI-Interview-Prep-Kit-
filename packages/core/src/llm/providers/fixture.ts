/**
 * A provider that answers from a script instead of a network.
 *
 * This is what lets the whole pipeline be tested offline, deterministically, and
 * without spending a free-tier quota that is capped at 200,000 tokens per day.
 * It can also be told to misbehave in the specific ways the real API does, so the
 * failure paths are exercised rather than assumed:
 *
 *   - rate limits, with and without a Retry-After
 *   - an empty generation (measured: happens when reasoning eats the output budget)
 *   - prose instead of JSON
 *   - output that parses but does not satisfy the schema
 *   - a hang, for deadline handling
 */
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from '../provider.js';

export interface ScriptedFailure {
  code: LlmError['code'];
  retryAfterMs?: number;
  message?: string;
}

export interface FixtureProviderOptions {
  name?: string;
  model?: string;
  rpm?: number;
  tpm?: number;
  maxContextTokens?: number;
  supportsLowReasoning?: boolean;
  /**
   * What to answer. A function receives the request so a test can vary the reply
   * by prompt; a string is returned verbatim.
   */
  respond?: string | ((request: LlmRequest, callIndex: number) => string);
  /** Fail the first N calls with this error, then behave. */
  failFirst?: number;
  failure?: ScriptedFailure;
  /** Never resolve, so deadline handling can be tested. */
  hang?: boolean;
  /** Reported token usage per call. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FixtureProvider extends LlmProvider {
  /** Every request this provider was asked to serve, for assertions. */
  readonly calls: LlmRequest[];
}

export function createFixtureProvider(options: FixtureProviderOptions = {}): FixtureProvider {
  const calls: LlmRequest[] = [];
  let served = 0;

  return {
    name: options.name ?? 'fixture',
    model: options.model ?? 'fixture-model',
    calls,
    limits: {
      rpm: options.rpm ?? 1000,
      tpm: options.tpm ?? 1_000_000,
      maxContextTokens: options.maxContextTokens ?? 128_000,
      supportsJsonSchema: true,
      supportsLowReasoning: options.supportsLowReasoning ?? true,
    },

    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      const index = served;
      served += 1;

      if (options.hang === true) {
        await new Promise<never>((_, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(
              new LlmError({
                code: 'TIMEOUT',
                message: 'aborted',
                provider: 'fixture',
                model: 'fixture-model',
              }),
            );
          });
        });
      }

      if (options.failFirst !== undefined && index < options.failFirst) {
        const failure = options.failure ?? { code: 'SERVER' as const };
        throw new LlmError({
          code: failure.code,
          message: failure.message ?? `scripted ${failure.code} on call ${index + 1}`,
          provider: options.name ?? 'fixture',
          model: options.model ?? 'fixture-model',
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        });
      }

      const body =
        typeof options.respond === 'function'
          ? options.respond(request, index)
          : (options.respond ?? '{}');

      return {
        text: body,
        usage: options.usage ?? { inputTokens: 100, outputTokens: 200 },
        rateLimit: {},
      };
    },
  };
}
