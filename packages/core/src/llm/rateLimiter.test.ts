import { describe, expect, it } from 'vitest';
import {
  DualTokenBucket,
  estimateTokens,
  parseRetryAfter,
  RateLimitDeadlineError,
  RequestTooLargeError,
  type Clock,
} from './rateLimiter.js';

/** A clock that only moves when a sleep asks it to, so tests never wait. */
function fakeClock(): Clock & { advance(ms: number): void; elapsed(): number } {
  let t = 1_000_000;
  const start = t;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    elapsed: () => t - start,
  };
}

describe('the tokens-per-minute ceiling is what actually binds', () => {
  it('admits calls until the token budget is gone, then waits', async () => {
    const clock = fakeClock();
    // The measured free tier: plenty of requests, very few tokens.
    const bucket = new DualTokenBucket({ rpm: 30, tpm: 8000, clock });

    for (let i = 0; i < 4; i += 1) {
      await bucket.reserve(2000);
    }
    expect(clock.elapsed()).toBe(0); // 4 x 2000 = 8000, exactly the budget

    await bucket.reserve(2000); // the fifth must wait for a refill
    expect(clock.elapsed()).toBeGreaterThan(0);
  });

  it('waits on requests-per-minute when that is the tighter limit', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 2, tpm: 1_000_000, clock });
    await bucket.reserve(10);
    await bucket.reserve(10);
    expect(clock.elapsed()).toBe(0);
    await bucket.reserve(10);
    expect(clock.elapsed()).toBeGreaterThan(0);
  });
});

describe('reserve and settle', () => {
  it('refunds the unused output allowance', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 100, tpm: 10_000, clock });

    const reservation = await bucket.reserve(4000); // reserved for a big answer
    expect(bucket.snapshot.tokens).toBeCloseTo(6000, 0);

    reservation.settle(800); // it only cost 800
    expect(bucket.snapshot.tokens).toBeCloseTo(9200, 0);
  });

  it('lets the bucket go into debt when a call costs more than reserved', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 100, tpm: 10_000, clock });
    const reservation = await bucket.reserve(1000);
    reservation.settle(3000); // reasoning tokens blew past the estimate
    expect(bucket.snapshot.tokens).toBeCloseTo(7000, 0);
  });

  it('returns everything when a call never happens', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 100, tpm: 10_000, clock });
    const reservation = await bucket.reserve(4000);
    reservation.cancel();
    expect(bucket.snapshot.tokens).toBeCloseTo(10_000, 0);
    expect(bucket.snapshot.requests).toBeCloseTo(100, 0);
  });

  it('ignores a double settle', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 100, tpm: 10_000, clock });
    const reservation = await bucket.reserve(1000);
    reservation.settle(500);
    reservation.settle(500);
    expect(bucket.snapshot.tokens).toBeCloseTo(9500, 0);
  });
});

describe('admission control', () => {
  it('refuses a call larger than the entire per-minute budget instead of hanging', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 30, tpm: 8000, clock });
    // Without this check the reservation could never be satisfied and the caller
    // would block until its deadline — a hang presented as a timeout.
    await expect(bucket.reserve(9000)).rejects.toThrow(RequestTooLargeError);
  });

  it('gives up rather than sleeping past a deadline', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 1, tpm: 100, clock });
    await bucket.reserve(100);
    await expect(bucket.reserve(100, { deadline: clock.now() + 50 })).rejects.toThrow(
      RateLimitDeadlineError,
    );
  });
});

describe('a 429 stops every caller on the bucket', () => {
  it('pauses until the retry window has passed', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 100, tpm: 100_000, clock });
    bucket.penalise(5000);
    expect(bucket.snapshot.pausedForMs).toBe(5000);

    await bucket.reserve(100);
    // Even with budget to spare, the caller waited out the penalty.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(5000);
  });

  it('takes the server at its word when headers report less than we thought', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 30, tpm: 8000, clock });
    bucket.syncFromHeaders({ remainingTokens: 120, remainingRequests: 2 });
    expect(bucket.snapshot.tokens).toBe(120);
    expect(bucket.snapshot.requests).toBe(2);
  });

  it('never revises its estimate upward from a header', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 30, tpm: 8000, clock });
    await bucket.reserve(4000);
    bucket.syncFromHeaders({ remainingTokens: 7999 });
    expect(bucket.snapshot.tokens).toBeCloseTo(4000, 0);
  });
});

describe('waiters are served in order', () => {
  it('does not starve an early caller behind later ones', async () => {
    const clock = fakeClock();
    const bucket = new DualTokenBucket({ rpm: 60, tpm: 1000, clock });
    const order: number[] = [];
    const calls = [0, 1, 2, 3].map(async (i) => {
      await bucket.reserve(400);
      order.push(i);
    });
    await Promise.all(calls);
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('token estimation', () => {
  it('counts the output allowance, not just the prompt', () => {
    // The models in use are reasoning models: hidden reasoning is billed as
    // output, so a prompt-only estimate under-counts by more than half.
    const promptOnly = estimateTokens('x'.repeat(350), 0);
    const withOutput = estimateTokens('x'.repeat(350), 2000);
    expect(promptOnly).toBeLessThan(200);
    expect(withOutput).toBeGreaterThan(2000);
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-09-23T10:00:00Z');

  it('parses the integer-seconds form', () => {
    expect(parseRetryAfter('7', now)).toBe(7000);
  });

  it('parses the HTTP-date form — the one usually forgotten', () => {
    // Parsed as an integer this is NaN, which typically collapses to "retry now"
    // and straight into another 429.
    expect(parseRetryAfter('Wed, 23 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
  });

  it('parses the duration form some providers put in the error body', () => {
    expect(parseRetryAfter('7s', now)).toBe(7000);
    expect(parseRetryAfter('1.5s', now)).toBe(1500);
    expect(parseRetryAfter('500ms', now)).toBe(500);
  });

  it('returns null for nothing usable', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });

  it('never returns a negative wait for a date already past', () => {
    expect(parseRetryAfter('Wed, 23 Sep 2026 09:59:00 GMT', now)).toBe(0);
  });
});
