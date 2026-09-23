import { describe, expect, it } from 'vitest';
import { applyReview, orderSession, summarise, type CardState } from './schedule.js';

const NOW = Date.parse('2026-09-23T09:00:00Z');

function card(id: string, overrides: Partial<CardState> = {}): CardState {
  return {
    cardId: id,
    seenCount: 1,
    lastConfidence: 2,
    streak: 1,
    lapses: 0,
    ease: 2.3,
    dueAt: NOW,
    ...overrides,
  };
}

const HOURS = (n: number) => n;

describe('intervals respect the deadline', () => {
  it('never schedules a card past the interview', () => {
    // A card due after the interview is worth nothing, however well you knew it.
    for (const hoursLeft of [1, 6, 24, 72, 24 * 14]) {
      const outcome = applyReview(card('f1', { streak: 5 }), 3, NOW, hoursLeft);
      expect(outcome.intervalHours).toBeLessThanOrEqual(hoursLeft);
    }
  });

  it('compresses an easy card so it is seen again before the interview', () => {
    // Classic SM-2 returns an easy card in about 72 hours — i.e. exactly when
    // the interview starts, which is useless. Compressed, it comes back with
    // room to be seen at least once more.
    const soon = applyReview(card('f1', { streak: 1 }), 3, NOW, HOURS(72));
    expect(soon.intervalHours).toBeLessThan(72 * 0.5);
    expect(soon.intervalHours).toBeGreaterThan(1);
  });

  it('adds an ordering rule the classic algorithm has no concept of', () => {
    // Blanked > never seen > found hard > comfortable. Coverage sits above
    // polish, but a total blank still comes first.
    const order = orderSession(
      [
        card('easy', { lastConfidence: 3, streak: 2 }),
        card('hard', { lastConfidence: 1 }),
        card('unseen', { seenCount: 0, lastConfidence: null }),
        card('blank', { lastConfidence: 0 }),
      ],
      NOW,
    );
    expect(order.map((c) => c.cardId)).toEqual(['blank', 'unseen', 'hard', 'easy']);
  });

  it('behaves like ordinary spaced repetition when there is a fortnight', () => {
    const far = applyReview(card('f1', { streak: 1 }), 3, NOW, HOURS(24 * 14));
    const soon = applyReview(card('f1', { streak: 1 }), 3, NOW, HOURS(72));
    expect(far.intervalHours).toBeGreaterThan(soon.intervalHours);
  });

  it('brings a blanked card back within the same session', () => {
    const outcome = applyReview(card('f1'), 0, NOW, HOURS(72));
    expect(outcome.intervalHours).toBeLessThan(1);
    expect(outcome.streak).toBe(0);
    expect(outcome.lapses).toBe(1);
  });

  it('moves ease within bounds rather than running away', () => {
    let state = card('f1', { ease: 2.3 });
    for (let i = 0; i < 20; i += 1) {
      const outcome = applyReview(state, 0, NOW, HOURS(72));
      state = { ...state, ease: outcome.ease };
    }
    expect(state.ease).toBeGreaterThanOrEqual(1.3);

    let easy = card('f2', { ease: 2.3 });
    for (let i = 0; i < 20; i += 1) {
      const outcome = applyReview(easy, 3, NOW, HOURS(72));
      easy = { ...easy, ease: outcome.ease };
    }
    expect(easy.ease).toBeLessThanOrEqual(2.6);
  });
});

describe('the next session leads with what was least confident', () => {
  it('puts a blanked card ahead of a comfortable one', () => {
    const order = orderSession([card('good', { lastConfidence: 3, streak: 3 }), card('bad', { lastConfidence: 0 })], NOW);
    expect(order[0]!.cardId).toBe('bad');
  });

  it('puts an unseen card ahead of a merely shaky one', () => {
    // A card never practised is a total gap; a shaky one is a partial gap.
    const order = orderSession(
      [card('shaky', { lastConfidence: 1 }), card('unseen', { seenCount: 0, lastConfidence: null })],
      NOW,
    );
    expect(order[0]!.cardId).toBe('unseen');
  });

  it('stops drilling what is already solid', () => {
    const order = orderSession(
      [card('solid', { lastConfidence: 3, streak: 4 }), card('new', { seenCount: 0, lastConfidence: null })],
      NOW,
    );
    expect(order.at(-1)!.cardId).toBe('solid');
  });

  it('lifts a card that covers a must-have over an equivalent one that does not', () => {
    const order = orderSession(
      [card('nice', { lastConfidence: 1 }), card('must', { lastConfidence: 1, coversMust: true })],
      NOW,
    );
    expect(order[0]!.cardId).toBe('must');
  });

  it('explains every card position', () => {
    const order = orderSession([card('a', { seenCount: 0, lastConfidence: null }), card('b', { lastConfidence: 0 })], NOW);
    for (const entry of order) expect(entry.reason.length).toBeGreaterThan(0);
    expect(order.find((c) => c.cardId === 'a')!.reason).toContain('not practised');
  });

  it('is deterministic and respects the session limit', () => {
    const cards = Array.from({ length: 30 }, (_, i) => card(`f${i}`));
    const first = orderSession(cards, NOW, 10);
    expect(first).toHaveLength(10);
    expect(JSON.stringify(first)).toBe(JSON.stringify(orderSession(cards, NOW, 10)));
  });

  it('handles an empty deck', () => {
    expect(orderSession([], NOW)).toEqual([]);
  });
});

describe('practice coverage', () => {
  it('separates seen, confident, shaky and never-touched', () => {
    const stats = summarise([
      card('a', { seenCount: 0, lastConfidence: null }),
      card('b', { lastConfidence: 1 }),
      card('c', { lastConfidence: 3, streak: 2 }),
    ]);
    expect(stats).toEqual({ total: 3, seen: 2, confident: 1, shaky: 1, unseen: 1 });
  });
});
