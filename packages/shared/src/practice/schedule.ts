/**
 * Ordering a practice session.
 *
 * The brief leaves this open — "a simple confidence-weighted sort is fine; a
 * proper spaced-repetition interval is fine. Pick one and defend it" — so here
 * is the defence.
 *
 * CLASSIC SM-2 IS THE WRONG ALGORITHM FOR THIS PROBLEM. Its objective is
 * long-term retention at minimum review cost, and its intervals say so: a card
 * graded Good returns in six days. If the interview is on Thursday, a card you
 * half-knew on Monday resurfaces after the thing you were revising for. The
 * objective here is different and has a deadline: maximise coverage times
 * confidence at a fixed moment in time.
 *
 * So the spacing intuition is kept and the clock is replaced. Every interval is
 * scaled by how much runway is left, and nothing is ever scheduled past the
 * interview, because a card due afterwards is worth nothing. With three days
 * left an "easy" card returns in about thirteen hours instead of three days;
 * with a fortnight left the behaviour is close to ordinary SM-2.
 *
 * Session ORDER is a separate question from when a card is due, because "order
 * the next session by what they were least confident about" is a ranking
 * requirement. The score is explainable on purpose: every card can say why it
 * is in front of you, and a ranking you can justify is worth more than one you
 * cannot.
 */

/** Again, Hard, Good, Easy. */
export type Confidence = 0 | 1 | 2 | 3;

export interface CardState {
  cardId: string;
  seenCount: number;
  lastConfidence: Confidence | null;
  streak: number;
  lapses: number;
  ease: number;
  dueAt: number;
  /** Whether this card revises a must-have requirement. */
  coversMust?: boolean;
}

/** Base return interval in hours, before the horizon is applied. */
const BASE_HOURS: Record<Confidence, number> = { 0: 0.2, 1: 2, 2: 20, 3: 72 };
const EASE_DELTA: Record<Confidence, number> = { 0: -0.3, 1: -0.15, 2: 0.0, 3: 0.1 };
const EASE_MIN = 1.3;
const EASE_MAX = 2.6;
/** Beyond a week of runway, behave like ordinary spaced repetition. */
const FULL_HORIZON_HOURS = 7 * 24;

export interface ReviewOutcome {
  ease: number;
  streak: number;
  lapses: number;
  intervalHours: number;
  dueAt: number;
}

export function applyReview(
  card: CardState,
  confidence: Confidence,
  now: number,
  hoursToInterview: number,
): ReviewOutcome {
  const ease = clamp(card.ease + EASE_DELTA[confidence], EASE_MIN, EASE_MAX);
  const streak = confidence === 0 ? 0 : card.streak + 1;
  const lapses = confidence === 0 ? card.lapses + 1 : card.lapses;

  const horizon = Math.min(1, Math.max(0.05, hoursToInterview / FULL_HORIZON_HOURS));
  const raw = BASE_HOURS[confidence] * Math.pow(ease, Math.max(0, streak - 1));

  // Never schedule past the interview: the ceiling is a fraction of what is
  // left, so every card gets seen again while it can still matter.
  const ceiling = Math.max(0.5, hoursToInterview * 0.4);
  const intervalHours = clamp(raw * horizon, 0.2, ceiling);

  return { ease, streak, lapses, intervalHours, dueAt: now + intervalHours * 3600_000 };
}

export interface RankedCard {
  cardId: string;
  score: number;
  /** Shown to the user, so the ordering is never mysterious. */
  reason: string;
}

/**
 * Order the next session. Least confident first, but coverage of unseen
 * material outranks drilling something already shaky, because a card never seen
 * is a total gap and a shaky card is a partial one.
 */
export function orderSession(cards: CardState[], now: number, limit = 20): RankedCard[] {
  const scored = cards.map((card) => {
    let score = 0;
    const reasons: string[] = [];

    if (card.seenCount === 0) {
      // Calibrated deliberately between "Again" (7.5) and "Hard" (5.0): a card
      // you blanked on is more urgent than one you have never seen, but a card
      // you have never seen is a total gap and outranks one you merely found
      // hard. Coverage before polish.
      score += 5.5;
      reasons.push('not practised yet');
    } else {
      const confidence = card.lastConfidence ?? 0;
      const weight = 2.5 * (3 - confidence);
      score += weight;
      if (confidence <= 1) reasons.push(confidence === 0 ? 'you drew a blank on this' : 'you found this hard');
    }

    if (card.lapses >= 3) {
      score += 1.5;
      reasons.push('keeps slipping');
    }
    if (card.coversMust === true) {
      score += 1.0;
      reasons.push('covers a must-have');
    }
    if (card.dueAt <= now && card.seenCount > 0) {
      score += Math.min(1.5, (now - card.dueAt) / 3600_000 / 12);
      reasons.push('due for review');
    }
    if (card.streak >= 2) {
      // Stop drilling what is already solid.
      score -= 1.2;
      if (reasons.length === 0) reasons.push('solid — light touch');
    }

    return {
      cardId: card.cardId,
      score,
      reason: reasons[0] ?? 'keeping it fresh',
    };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.cardId.localeCompare(b.cardId))
    .slice(0, limit);
}

export interface PracticeStats {
  total: number;
  seen: number;
  confident: number;
  shaky: number;
  unseen: number;
}

/** Practice coverage, which is a different question from kit coverage. */
export function summarise(cards: CardState[]): PracticeStats {
  const seen = cards.filter((c) => c.seenCount > 0);
  return {
    total: cards.length,
    seen: seen.length,
    confident: seen.filter((c) => (c.lastConfidence ?? 0) >= 2 && c.streak >= 1).length,
    shaky: seen.filter((c) => (c.lastConfidence ?? 0) <= 1).length,
    unseen: cards.length - seen.length,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
