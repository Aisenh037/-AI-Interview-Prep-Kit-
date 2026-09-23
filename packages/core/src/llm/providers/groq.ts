/**
 * Groq adapter (OpenAI-compatible chat completions).
 *
 * Everything here was verified against the live API rather than assumed:
 *   - `llama-3.3-70b-versatile` left the free tier on 16 Aug 2026; the free
 *     replacement is `openai/gpt-oss-120b`.
 *   - Free-tier limits are 30 requests/minute and 8,000 tokens/minute, reported
 *     per model — which is what lets the router run three independent buckets.
 *   - `openai/gpt-oss-120b` supports strict schema-constrained decoding.
 *   - `reasoning_effort: 'low'` makes the 120b model return an EMPTY generation
 *     under strict schema mode, and the request fails with json_validate_failed.
 *     It is safe on the 20b model. Hence `supportsLowReasoning` per model.
 */
import { LlmError, toStrictJsonSchema, type LlmProvider, type LlmRequest, type LlmResponse } from '../provider.js';
import { parseRetryAfter } from '../rateLimiter.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Measured free-tier limits. Seeded here, then corrected at runtime from headers. */
const DEFAULT_LIMITS = { rpm: 30, tpm: 8000 } as const;

export interface GroqProviderOptions {
  apiKey: string;
  model: string;
  /** Only the smaller model tolerates a low reasoning budget with strict JSON. */
  supportsLowReasoning?: boolean;
  rpm?: number;
  tpm?: number;
  maxContextTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface GroqChoice {
  message?: { content?: string | null };
}

interface GroqBody {
  choices?: GroqChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

export function createGroqProvider(options: GroqProviderOptions): LlmProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 45_000;
  const model = options.model;

  return {
    name: 'groq',
    model,
    limits: {
      rpm: options.rpm ?? DEFAULT_LIMITS.rpm,
      tpm: options.tpm ?? DEFAULT_LIMITS.tpm,
      maxContextTokens: options.maxContextTokens ?? 131_072,
      supportsJsonSchema: true,
      supportsLowReasoning: options.supportsLowReasoning ?? false,
    },

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model,
        temperature: request.temperature ?? 0,
        max_completion_tokens: request.maxOutputTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      };

      if (request.reasoningEffort !== undefined) {
        body['reasoning_effort'] = request.reasoningEffort;
      }
      if (request.jsonSchema !== undefined) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: request.jsonSchema.name,
            strict: true,
            schema: toStrictJsonSchema(request.jsonSchema.schema),
          },
        };
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        const aborted = (error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError';
        throw new LlmError({
          code: aborted ? 'TIMEOUT' : 'NETWORK',
          message: `groq request failed: ${(error as Error).message}`,
          provider: 'groq',
          model,
        });
      }

      const rateLimit = {
        remainingRequests: numberHeader(response, 'x-ratelimit-remaining-requests'),
        remainingTokens: numberHeader(response, 'x-ratelimit-remaining-tokens'),
      };

      let parsed: GroqBody;
      try {
        parsed = (await response.json()) as GroqBody;
      } catch {
        throw new LlmError({
          code: response.ok ? 'INVALID_OUTPUT' : 'SERVER',
          message: `groq returned a non-JSON body with status ${response.status}`,
          provider: 'groq',
          model,
          status: response.status,
        });
      }

      if (!response.ok || parsed.error !== undefined) {
        throw toLlmError(response, parsed, model, now());
      }

      const text = parsed.choices?.[0]?.message?.content ?? '';
      return {
        text,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
        rateLimit,
      };
    },
  };
}

function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function toLlmError(response: Response, body: GroqBody, model: string, now: number): LlmError {
  const message = body.error?.message ?? `groq request failed with status ${response.status}`;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now) ?? undefined;

  const code = ((): LlmError['code'] => {
    if (response.status === 429) return 'RATE_LIMIT';
    if (response.status === 401 || response.status === 403) return 'AUTH';
    if (response.status >= 500) return 'SERVER';
    // The model produced output that did not satisfy the schema. Retrying the
    // same call rarely helps; the caller should repair or fall back.
    if (body.error?.code === 'json_validate_failed') return 'INVALID_OUTPUT';
    if (response.status === 400) return 'BAD_REQUEST';
    return 'SERVER';
  })();

  return new LlmError({
    code,
    message,
    provider: 'groq',
    model,
    status: response.status,
    retryAfterMs,
  });
}
