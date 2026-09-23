import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmRouter, type StructuredCall, type StructuredResult } from './router.js';
import { createFixtureProvider } from './providers/fixture.js';
import type { Clock } from './rateLimiter.js';

const Answer = z.object({ answer: z.string() });
type Answer = z.infer<typeof Answer>;

function fakeClock(): Clock & { elapsed(): number } {
  let t = 1_000_000;
  const start = t;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t - start,
  };
}

type CallOverrides = Partial<Pick<StructuredCall<Answer>, 'callClass' | 'maxOutputTokens' | 'deadline'>>;

function call(router: LlmRouter, overrides: CallOverrides = {}): Promise<StructuredResult<Answer>> {
  return router.callStructured<Answer>({
    callClass: 'extract',
    system: 'system',
    user: 'user',
    schema: Answer,
    schemaName: 'answer',
    fallback: () => ({ answer: 'deterministic' }),
    ...overrides,
  });
}

describe('a kit is always producible', () => {
  it('returns the model result when the model behaves', async () => {
    const provider = createFixtureProvider({ respond: '{"answer":"from the model"}' });
    const result = await call(new LlmRouter([provider], { clock: fakeClock() }));
    expect(result.origin).toBe('model');
    expect(result.value.answer).toBe('from the model');
  });

  it('falls back when every provider is unreachable, rather than throwing', async () => {
    const provider = createFixtureProvider({ failFirst: 99, failure: { code: 'SERVER' } });
    const result = await call(new LlmRouter([provider], { clock: fakeClock(), random: () => 0.5 }));
    expect(result.origin).toBe('fallback');
    expect(result.value.answer).toBe('deterministic');
    expect(result.warnings.some((w) => w.startsWith('FALLBACK_USED'))).toBe(true);
  });

  it('falls back on an empty generation', async () => {
    // Measured behaviour: with too small an output budget the model spends it all
    // on reasoning and returns nothing at all.
    const provider = createFixtureProvider({ respond: '' });
    const result = await call(new LlmRouter([provider], { clock: fakeClock(), random: () => 0.5 }));
    expect(result.origin).toBe('fallback');
  });

  it('falls back when output parses but violates the schema', async () => {
    const provider = createFixtureProvider({ respond: '{"unexpected":true}' });
    const result = await call(new LlmRouter([provider], { clock: fakeClock(), random: () => 0.5 }));
    expect(result.origin).toBe('fallback');
    expect(result.warnings.some((w) => w.includes('validation'))).toBe(true);
  });

  it('falls back on a refusal, rather than treating prose as a result', async () => {
    const provider = createFixtureProvider({ respond: 'I cannot help with that request.' });
    const result = await call(new LlmRouter([provider], { clock: fakeClock(), random: () => 0.5 }));
    expect(result.origin).toBe('fallback');
  });
});

describe('retrying and failing over', () => {
  it('retries a transient server error and then succeeds', async () => {
    const provider = createFixtureProvider({
      failFirst: 2,
      failure: { code: 'SERVER' },
      respond: '{"answer":"recovered"}',
    });
    const result = await call(new LlmRouter([provider], { clock: fakeClock(), random: () => 0.5 }));
    expect(result.origin).toBe('model');
    expect(result.value.answer).toBe('recovered');
    expect(provider.calls).toHaveLength(3);
  });

  it('honours Retry-After on a rate limit instead of hammering', async () => {
    const clock = fakeClock();
    const provider = createFixtureProvider({
      failFirst: 1,
      failure: { code: 'RATE_LIMIT', retryAfterMs: 5000 },
      respond: '{"answer":"after the wait"}',
    });
    const result = await call(new LlmRouter([provider], { clock, random: () => 1 }));
    expect(result.origin).toBe('model');
    expect(clock.elapsed()).toBeGreaterThanOrEqual(5000);
  });

  it('moves to the next provider immediately on a non-retryable error', async () => {
    const broken = createFixtureProvider({
      model: 'broken',
      failFirst: 99,
      failure: { code: 'AUTH' },
    });
    const working = createFixtureProvider({ model: 'working', respond: '{"answer":"second"}' });
    const result = await call(
      new LlmRouter([broken, working], { clock: fakeClock(), random: () => 0.5 }),
    );
    expect(result.value.answer).toBe('second');
    // An auth failure is not retried three times before moving on.
    expect(broken.calls).toHaveLength(1);
  });

  it('fails over to a second model when the first keeps failing', async () => {
    const first = createFixtureProvider({ model: 'first', failFirst: 99, failure: { code: 'SERVER' } });
    const second = createFixtureProvider({ model: 'second', respond: '{"answer":"backup"}' });
    const result = await call(
      new LlmRouter([first, second], { clock: fakeClock(), random: () => 0.5 }),
    );
    expect(result.origin).toBe('model');
    expect(result.value.answer).toBe('backup');
  });
});

describe('per-model buckets multiply the token budget', () => {
  it('reports the aggregate ceiling across every model', () => {
    // The free tier meters 8,000 tokens/minute PER MODEL, so three models is
    // three independent buckets — which is what makes the batch budget fit.
    const router = new LlmRouter(
      [
        createFixtureProvider({ model: 'a', tpm: 8000 }),
        createFixtureProvider({ model: 'b', tpm: 8000 }),
        createFixtureProvider({ model: 'c', tpm: 8000 }),
      ],
      { clock: fakeClock() },
    );
    expect(router.providerCount).toBe(3);
    expect(router.aggregateTpm).toBe(24_000);
  });

  it('spends one model’s budget without touching another’s', async () => {
    const clock = fakeClock();
    const big = createFixtureProvider({
      model: 'big',
      maxContextTokens: 131_072,
      tpm: 8000,
      respond: '{"answer":"big"}',
    });
    const small = createFixtureProvider({
      model: 'small',
      maxContextTokens: 8000,
      tpm: 8000,
      respond: '{"answer":"small"}',
    });
    const router = new LlmRouter([big, small], { clock, defaultMaxOutputTokens: 1500 });

    // Quality work goes to the larger model...
    const quality = await call(router, { callClass: 'extract' });
    expect(quality.value.answer).toBe('big');

    // ...and mechanical work goes to the small one, so it does not compete for
    // the same bucket.
    const mechanical = await call(router, { callClass: 'rerank' });
    expect(mechanical.value.answer).toBe('small');
  });

  it('sends mechanical work to the cheap model with a low reasoning budget', async () => {
    const small = createFixtureProvider({
      model: 'small',
      maxContextTokens: 8000,
      supportsLowReasoning: true,
      respond: '{"answer":"ok"}',
    });
    const router = new LlmRouter([small], { clock: fakeClock() });
    await call(router, { callClass: 'rerank' });
    expect(small.calls[0]!.reasoningEffort).toBe('low');
  });

  it('never sends a low reasoning budget to a model that breaks on it', async () => {
    // Measured: on the larger model, reasoning_effort "low" returns an EMPTY
    // generation under strict schema mode and the request fails outright.
    const big = createFixtureProvider({
      model: 'big',
      supportsLowReasoning: false,
      respond: '{"answer":"ok"}',
    });
    const router = new LlmRouter([big], { clock: fakeClock() });
    await call(router, { callClass: 'rerank' });
    expect(big.calls[0]!.reasoningEffort).toBeUndefined();
  });
});

describe('reporting', () => {
  it('accumulates token usage so a run can be costed', async () => {
    const provider = createFixtureProvider({
      respond: '{"answer":"x"}',
      usage: { inputTokens: 300, outputTokens: 450 },
    });
    const result = await call(new LlmRouter([provider], { clock: fakeClock() }));
    expect(result.usage.calls).toBe(1);
  });

  it('records when output had to be repaired, rather than hiding it', async () => {
    const provider = createFixtureProvider({ respond: '```json\n{"answer":"fenced"}\n```' });
    const result = await call(new LlmRouter([provider], { clock: fakeClock() }));
    expect(result.origin).toBe('model');
    expect(result.warnings.some((w) => w.startsWith('LLM_OUTPUT_REPAIRED'))).toBe(true);
  });
});
