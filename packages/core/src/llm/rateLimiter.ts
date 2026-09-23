/**
 * Rate limiting.
 *
 * The brief singles this out: "free tiers limit tokens per minute, not just
 * requests, and that limit is easy to hit. A pipeline that falls over the first
 * time a provider says 'slow down' is the most common way to lose points here."
 *
 * Measured against the real provider, the free tier allows 30 requests/minute but
 * only 8,000 TOKENS/minute — so tokens are the binding constraint by a wide
 * margin, and a limiter that only counts requests would sail straight into a 429.
 *
 * Three details carry most of the weight:
 *
 *  1. TOKENS ARE RESERVED BEFORE THE CALL, INCLUDING OUTPUT. The models in use are
 *     reasoning models whose hidden reasoning is billed as output; a measured
 *     extraction call spent 300 input tokens and 488 output. Estimating input
 *     alone would under-count by more than half. We reserve the full possible
 *     output and refund the unused part once the real usage is known.
 *
 *  2. THE BUCKET IS PROCESS-GLOBAL, NOT PER-CASE. The batch harness runs several
 *     cases at once; per-case limiters would each believe they had the whole
 *     budget and would multiply 429s rather than prevent them.
 *
 *  3. A 429 PAUSES EVERY CALLER, not just the one that hit it. The quota is
 *     shared, so one caller's rejection is everyone's information.
 *
 * The clock is injected, so the waiting behaviour is testable without real time.
 */

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export class RateLimitDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitDeadlineError';
  }
}

/** The request could never be satisfied — it asks for more than the whole budget. */
export class RequestTooLargeError extends Error {
  readonly estimated: number;
  readonly capacity: number;
  constructor(estimated: number, capacity: number) {
    super(
      `a call estimated at ${estimated} tokens can never fit a ${capacity} tokens/minute budget`,
    );
    this.name = 'RequestTooLargeError';
    this.estimated = estimated;
    this.capacity = capacity;
  }
}

export interface RateLimitHeaders {
  remainingRequests?: number | undefined;
  remainingTokens?: number | undefined;
}

export interface Reservation {
  /** Called with the real total token usage; refunds the over-reservation. */
  settle(actualTokens: number): void;
  /** The call never happened; give everything back. */
  cancel(): void;
}

export interface DualTokenBucketOptions {
  /** Requests per minute. */
  rpm: number;
  /** Tokens per minute — for free tiers, the one that actually binds. */
  tpm: number;
  clock?: Clock;
  /** Label used in error messages, usually the model id. */
  name?: string;
}

const MIN_WAIT_MS = 25;
const MAX_WAIT_MS = 15_000;

export class DualTokenBucket {
  readonly name: string;
  readonly rpm: number;
  readonly tpm: number;

  private readonly clock: Clock;
  private requestTokens: number;
  private tokenTokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  /** FIFO gate: waiters are served in arrival order, so nothing starves. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: DualTokenBucketOptions) {
    this.rpm = options.rpm;
    this.tpm = options.tpm;
    this.clock = options.clock ?? systemClock;
    this.name = options.name ?? 'llm';
    this.requestTokens = options.rpm;
    this.tokenTokens = options.tpm;
    this.lastRefill = this.clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.requestTokens = Math.min(this.rpm, this.requestTokens + (elapsed * this.rpm) / 60_000);
    this.tokenTokens = Math.min(this.tpm, this.tokenTokens + (elapsed * this.tpm) / 60_000);
    this.lastRefill = now;
  }

  /** Server truth always wins downward; we never revise our estimate upward from a header. */
  syncFromHeaders(headers: RateLimitHeaders): void {
    this.refill();
    if (typeof headers.remainingRequests === 'number') {
      this.requestTokens = Math.min(this.requestTokens, headers.remainingRequests);
    }
    if (typeof headers.remainingTokens === 'number') {
      this.tokenTokens = Math.min(this.tokenTokens, headers.remainingTokens);
    }
  }

  /** A 429 stops every caller on this bucket, not just the one that was refused. */
  penalise(retryAfterMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + retryAfterMs);
    this.requestTokens = 0;
    this.tokenTokens = 0;
    this.lastRefill = this.clock.now();
  }

  get snapshot(): { requests: number; tokens: number; pausedForMs: number } {
    return {
      requests: this.requestTokens,
      tokens: this.tokenTokens,
      pausedForMs: Math.max(0, this.pausedUntil - this.clock.now()),
    };
  }

  /**
   * Wait until there is room, then take it.
   *
   * Throws RequestTooLargeError immediately if the estimate exceeds the whole
   * per-minute budget. Without that check the reservation could never be
   * satisfied and the caller would block until its deadline — a hang, not an
   * error. The caller's job on seeing it is to shrink the call (truncate page
   * context, shard the requirement list) and try again.
   */
  async reserve(
    estimatedTokens: number,
    options: { deadline?: number; signal?: AbortSignal } = {},
  ): Promise<Reservation> {
    const estimate = Math.max(1, Math.ceil(estimatedTokens));
    if (estimate > this.tpm) throw new RequestTooLargeError(estimate, this.tpm);

    const previous = this.tail;
    let releaseGate: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await previous;

    try {
      for (;;) {
        if (options.signal?.aborted === true) throw new Error('aborted');
        this.refill();
        const now = this.clock.now();

        let wait: number;
        if (now < this.pausedUntil) {
          wait = this.pausedUntil - now;
        } else if (this.requestTokens >= 1 && this.tokenTokens >= estimate) {
          this.requestTokens -= 1;
          this.tokenTokens -= estimate;
          return this.makeReservation(estimate);
        } else {
          const needRequests = Math.max(0, 1 - this.requestTokens) * (60_000 / this.rpm);
          const needTokens = Math.max(0, estimate - this.tokenTokens) * (60_000 / this.tpm);
          wait = Math.max(needRequests, needTokens);
        }

        wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.ceil(wait)));
        if (options.deadline !== undefined && now + wait > options.deadline) {
          throw new RateLimitDeadlineError(
            `${this.name}: waiting ${wait}ms for quota would pass the deadline`,
          );
        }
        await this.clock.sleep(wait, options.signal);
      }
    } finally {
      releaseGate();
    }
  }

  private makeReservation(estimate: number): Reservation {
    let closed = false;
    return {
      settle: (actualTokens: number) => {
        if (closed) return;
        closed = true;
        const refund = estimate - Math.max(0, actualTokens);
        // A negative refund is a genuine over-spend: let the bucket go into debt
        // so the next caller waits for it, rather than pretending it did not happen.
        this.tokenTokens = Math.min(this.tpm, this.tokenTokens + refund);
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        this.requestTokens = Math.min(this.rpm, this.requestTokens + 1);
        this.tokenTokens = Math.min(this.tpm, this.tokenTokens + estimate);
      },
    };
  }
}

/**
 * Estimate the tokens a call will cost before making it.
 *
 * Roughly 3.5 characters per token for English prose, plus 15% headroom, plus the
 * FULL output allowance. Over-reserving and refunding is deliberate: under-reserving
 * is what produces a 429 storm, and the refund path costs nothing.
 */
export function estimateTokens(prompt: string, maxOutputTokens: number): number {
  const input = Math.ceil(prompt.length / 3.5) * 1.15;
  return Math.ceil(input + maxOutputTokens);
}

/**
 * `Retry-After` arrives in two forms and the HTTP-date form is the one that gets
 * forgotten: parsing it as an integer yields NaN, which usually collapses to "retry
 * immediately" and straight into another 429.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);

  // Some providers report "7s" or "1.5s" in a JSON error body instead.
  const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i.exec(trimmed);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unit = duration[2]!.toLowerCase();
    if (unit === 'ms') return amount;
    if (unit === 's') return amount * 1000;
    return amount * 60_000;
  }
  return null;
}
