import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Question, Requirement } from '@kit/shared';
import { allocateSchedule, InvalidScheduleInput, questionCost } from './allocateSchedule.js';

function req(id: string, priority: 'must' | 'nice' = 'must'): Requirement {
  return { id, text: `Requirement ${id} about distributed systems`, kind: 'technical', priority };
}

function q(id: string, requirementIds: string[], difficulty: 1 | 2 | 3 = 2): Question {
  return {
    id,
    requirement_ids: requirementIds,
    category: 'technical',
    prompt: `Question ${id}`,
    answer_outline: 'outline',
    difficulty,
  };
}

/** n questions spread across n/2 requirements, half of them must-haves. */
function corpus(n: number): { questions: Question[]; requirements: Requirement[] } {
  const requirements: Requirement[] = [];
  const questions: Question[] = [];
  for (let i = 0; i < n; i += 1) {
    const rid = `r${Math.floor(i / 2) + 1}`;
    if (!requirements.some((r) => r.id === rid)) {
      requirements.push(req(rid, i % 4 === 0 ? 'nice' : 'must'));
    }
    questions.push(q(`q${i + 1}`, [rid], ((i % 3) + 1) as 1 | 2 | 3));
  }
  return { questions, requirements };
}

const DAY_COUNTS = [1, 2, 3, 5, 7, 14, 30, 60];

describe('the number of days equals the number of days requested', () => {
  it.each(DAY_COUNTS)('produces exactly %i day(s)', (days) => {
    const { questions, requirements } = corpus(20);
    const { schedule } = allocateSchedule({ questions, requirements, days });
    expect(schedule.days).toHaveLength(days);
    expect(schedule.days_available).toBe(days);
    expect(schedule.days.map((d) => d.day)).toEqual(
      Array.from({ length: days }, (_, i) => i + 1),
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid day count: %s', (days) => {
    const { questions, requirements } = corpus(4);
    expect(() => allocateSchedule({ questions, requirements, days })).toThrow(InvalidScheduleInput);
  });
});

describe('every must-have requirement appears somewhere', () => {
  it.each(DAY_COUNTS)('with %i day(s)', (days) => {
    const { questions, requirements } = corpus(24);
    const { schedule } = allocateSchedule({ questions, requirements, days });
    const scheduledIds = new Set(schedule.days.flatMap((d) => d.question_ids));
    const covered = questions.filter((question) => scheduledIds.has(question.id));

    for (const requirement of requirements.filter((r) => r.priority === 'must')) {
      expect(
        covered.some((question) => question.requirement_ids.includes(requirement.id)),
        `must-have ${requirement.id} is missing from a ${days}-day schedule`,
      ).toBe(true);
    }
  });

  it('never drops a question, even when material far exceeds the days available', () => {
    const { questions, requirements } = corpus(120);
    const { schedule } = allocateSchedule({ questions, requirements, days: 2 });
    const scheduled = new Set(schedule.days.flatMap((d) => d.question_ids));
    for (const question of questions) expect(scheduled.has(question.id)).toBe(true);
  });
});

describe('durations are integer minutes', () => {
  it.each(DAY_COUNTS)('across a %i-day plan', (days) => {
    const { questions, requirements } = corpus(17);
    const { schedule } = allocateSchedule({ questions, requirements, days });
    for (const day of schedule.days) {
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });

  it('budgets 10, 15 and 20 minutes for difficulty 1, 2 and 3', () => {
    expect(questionCost(q('a', [], 1))).toBe(10);
    expect(questionCost(q('a', [], 2))).toBe(15);
    expect(questionCost(q('a', [], 3))).toBe(20);
  });
});

describe('harder and higher-priority material lands earlier', () => {
  it('puts the hardest material on day 1 and the lightest on the final day', () => {
    const { questions, requirements } = corpus(30);
    const { schedule } = allocateSchedule({ questions, requirements, days: 6 });
    const byId = new Map(questions.map((question) => [question.id, question]));
    const meanDifficulty = (ids: string[]) =>
      ids.length === 0
        ? 0
        : ids.reduce((sum, id) => sum + (byId.get(id)?.difficulty ?? 0), 0) / ids.length;

    const first = meanDifficulty(schedule.days[0]!.question_ids);
    const last = meanDifficulty(schedule.days.at(-1)!.question_ids);
    expect(first).toBeGreaterThanOrEqual(last);
  });

  it('schedules must-have material before nice-to-have material', () => {
    const requirements = [req('r1', 'nice'), req('r2', 'must')];
    const questions = [q('q1', ['r1'], 3), q('q2', ['r2'], 1)];
    const { schedule } = allocateSchedule({ questions, requirements, days: 4 });
    const firstAppearance = (id: string) =>
      schedule.days.findIndex((d) => d.question_ids.includes(id));
    // q2 is easier but covers a must-have, so it must not land after q1.
    expect(firstAppearance('q2')).toBeLessThanOrEqual(firstAppearance('q1'));
  });

  it('keeps the night before the interview light', () => {
    const { questions, requirements } = corpus(40);
    const { schedule } = allocateSchedule({ questions, requirements, days: 7 });
    expect(schedule.days.at(-1)!.minutes).toBeLessThanOrEqual(schedule.days[0]!.minutes);
  });
});

describe('more days than material', () => {
  it('fills a 60-day plan from 6 questions without leaving a day empty', () => {
    const { questions, requirements } = corpus(6);
    const { schedule } = allocateSchedule({ questions, requirements, days: 60 });
    expect(schedule.days).toHaveLength(60);
    for (const day of schedule.days) {
      expect(day.focus.length).toBeGreaterThan(0);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });

  it('revisits material on surplus days rather than inventing new work', () => {
    const { questions, requirements } = corpus(6);
    const { schedule } = allocateSchedule({ questions, requirements, days: 30 });
    const known = new Set(questions.map((question) => question.id));
    for (const day of schedule.days) {
      for (const id of day.question_ids) expect(known.has(id)).toBe(true);
    }
    expect(schedule.days.some((d) => d.focus.startsWith('Review:'))).toBe(true);
  });
});

describe('a job description with nothing to extract', () => {
  it('still produces exactly the days requested, and says why it is thin', () => {
    const { schedule, warnings } = allocateSchedule({
      questions: [],
      requirements: [],
      days: 5,
    });
    expect(schedule.days).toHaveLength(5);
    expect(warnings).toContain('SCHEDULE_NO_MATERIAL');
    expect(schedule.days[0]!.question_ids).toEqual([]);
    expect(schedule.days[0]!.focus.toLowerCase()).toContain('too little');
  });
});

describe('the hiring page changes the plan', () => {
  it('prioritises system design when the company publishes a system design round', () => {
    const requirements = [req('r1'), req('r2')];
    const questions: Question[] = [
      { ...q('q1', ['r1'], 2), category: 'system-design' },
      { ...q('q2', ['r2'], 2), category: 'behavioural' },
    ];
    const without = allocateSchedule({ questions, requirements, days: 5 });
    const with_ = allocateSchedule({
      questions,
      requirements,
      days: 5,
      signals: { systemDesign: true },
    });
    const positionOf = (s: typeof without, id: string) =>
      s.schedule.days.findIndex((d) => d.question_ids.includes(id));
    expect(positionOf(with_, 'q1')).toBeLessThanOrEqual(positionOf(without, 'q1'));
  });
});

describe('determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const { questions, requirements } = corpus(25);
    const a = allocateSchedule({ questions, requirements, days: 9 });
    const b = allocateSchedule({ questions, requirements, days: 9 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('property: the invariants hold across the whole supported range', () => {
  it('days 1..60 by questions 0..60', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (days, questionCount) => {
          const { questions, requirements } = corpus(questionCount);
          const { schedule } = allocateSchedule({ questions, requirements, days });
          const ids = new Set(questions.map((question) => question.id));

          expect(schedule.days).toHaveLength(days);
          expect(schedule.days_available).toBe(days);
          for (const day of schedule.days) {
            expect(Number.isInteger(day.minutes)).toBe(true);
            expect(day.focus.length).toBeGreaterThan(0);
            for (const id of day.question_ids) expect(ids.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
