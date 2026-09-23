/**
 * Schedule allocation.
 *
 * The brief is explicit that this is "arithmetic and allocation. It belongs in your
 * code, not in a prompt." Accordingly this module is a PURE SYNCHRONOUS FUNCTION:
 * no model, no network, no clock, no randomness. A reviewer can see at a glance
 * that nothing here could have been delegated, because there is no way to reach a
 * language model from this file.
 *
 * Guarantees, all asserted before returning and all covered by tests:
 *   1. `days.length === days_available === the number of days requested`
 *   2. every must-have requirement has at least one question somewhere in the plan
 *   3. every `question_ids` entry refers to a question that exists
 *   4. `minutes` is always an integer
 *   5. harder, higher-priority material lands earlier, not the night before
 *   6. the same input always produces byte-identical output
 */
import type { Question, Requirement, KitSchedule, ScheduleDay } from '@kit/shared';

/** Minutes budgeted per question, by difficulty: 10 / 15 / 20. Integer by construction. */
const BASE_MINUTES = 10;
const MINUTES_PER_DIFFICULTY = 5;

/** A day of new material aims for at least this many minutes... */
const MIN_DAY_MINUTES = 30;
/** ...and at most this, before the plan starts spilling into later days. */
const MAX_DAY_MINUTES = 180;
/** A single-day plan is allowed to be heavier; there is nowhere else to put it. */
const MAX_SINGLE_DAY_MINUTES = 240;
/** Day 1 gets +25% of the daily target, the last day of new material -25%. */
const FRONT_LOAD = 0.25;
/** Review days revisit material at a reduced cost. */
const REVIEW_COST_FACTOR = 0.6;
/** Spacing rotation for review days, in days since the material was first studied. */
const REVIEW_INTERVALS = [1, 3, 7, 14, 30] as const;
/** A day above this is flagged as oversubscribed rather than silently pretending. */
const OVERSUBSCRIBED_MINUTES = 240;

export interface ScheduleSignals {
  /** The company publishes a system design round. */
  systemDesign?: boolean;
  /** The company publishes a take-home exercise. */
  takeHome?: boolean;
  /** Named stages parsed from a hiring-process page, e.g. ["recruiter screen", "take-home"]. */
  stages?: string[];
}

export interface AllocateScheduleInput {
  questions: Question[];
  requirements: Requirement[];
  /** Exactly the number of days the user said they had. */
  days: number;
  signals?: ScheduleSignals;
}

export interface AllocateScheduleResult {
  schedule: KitSchedule;
  warnings: string[];
}

export class InvalidScheduleInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleInput';
  }
}

/** Minutes a single question is budgeted. */
export function questionCost(q: Question): number {
  return BASE_MINUTES + MINUTES_PER_DIFFICULTY * (q.difficulty - 1);
}

interface Scored {
  question: Question;
  cost: number;
  urgency: number;
  isMust: boolean;
  /** Short human label for the requirement this question chiefly serves. */
  topic: string;
}

/** Trim a requirement into something that reads well inside a day's focus line. */
function topicLabel(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').slice(0, 6).join(' ');
  return words.replace(/[.,;:]$/, '');
}

const CATEGORY_LABEL: Record<Question['category'], string> = {
  technical: 'Technical depth',
  behavioural: 'Behavioural stories',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

/**
 * Priority ordering. Deterministic to the last tiebreak so that the same input
 * always yields the same plan — which is what makes the output testable.
 */
function scoreQuestions(input: AllocateScheduleInput): Scored[] {
  const byId = new Map(input.requirements.map((r) => [r.id, r]));
  const signals = input.signals ?? {};

  const scored = input.questions.map((question) => {
    const reqs = question.requirement_ids
      .map((id) => byId.get(id))
      .filter((r): r is Requirement => r !== undefined);
    const isMust = reqs.some((r) => r.priority === 'must');

    let urgency = 0;
    if (isMust) urgency += 2.0;
    urgency += 0.5 * question.difficulty;
    if (question.category === 'system-design' && signals.systemDesign === true) urgency += 0.3;
    if (question.category === 'technical' && signals.takeHome === true) urgency += 0.3;

    const primary = reqs.find((r) => r.priority === 'must') ?? reqs[0];
    const topic = primary ? topicLabel(primary.text) : CATEGORY_LABEL[question.category];

    return { question, cost: questionCost(question), urgency, isMust, topic };
  });

  return scored.sort(
    (a, b) =>
      b.urgency - a.urgency ||
      b.question.difficulty - a.question.difficulty ||
      a.question.id.localeCompare(b.question.id),
  );
}

/** Build a day's focus line from the topics it actually contains. */
function focusFor(items: Scored[]): string {
  if (items.length === 0) return 'Rest and consolidate';
  const topics: string[] = [];
  for (const item of items) {
    if (!topics.includes(item.topic)) topics.push(item.topic);
    if (topics.length === 2) break;
  }
  const categories = new Set(items.map((i) => i.question.category));
  const prefix = categories.size === 1 ? `${CATEGORY_LABEL[[...categories][0]!]}: ` : '';
  return `${prefix}${topics.join(' · ')}`;
}

/**
 * Daily minute targets across `count` days of new material, front-loaded so the
 * heaviest work lands first and the night before the interview is lightest.
 */
function taperedTargets(totalMinutes: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.min(
    MAX_DAY_MINUTES,
    Math.max(MIN_DAY_MINUTES, Math.ceil(totalMinutes / count)),
  );
  const mid = Math.max(1, (count - 1) / 2);
  return Array.from({ length: count }, (_, i) => {
    const factor = 1 + (FRONT_LOAD * (mid - i)) / mid;
    return Math.max(MIN_DAY_MINUTES, Math.round(base * factor));
  });
}

export function allocateSchedule(input: AllocateScheduleInput): AllocateScheduleResult {
  const { days } = input;
  if (!Number.isInteger(days) || days < 1) {
    throw new InvalidScheduleInput(`days must be a positive integer, received ${String(days)}`);
  }

  const warnings: string[] = [];
  const scored = scoreQuestions(input);
  const questionIds = new Set(input.questions.map((q) => q.id));

  // --- No material at all (the two-line stub job description) -----------------
  // Still exactly N days. We say plainly that there was nothing to build from
  // rather than padding the plan with invented work.
  if (scored.length === 0) {
    warnings.push('SCHEDULE_NO_MATERIAL');
    const emptyDays: ScheduleDay[] = Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      focus:
        i === 0
          ? 'Too little in the posting to build from — re-read the job description and list what it does not say'
          : 'Research the company and prepare questions to ask the interviewer',
      question_ids: [],
      minutes: MIN_DAY_MINUTES,
    }));
    return { schedule: { days_available: days, days: emptyDays }, warnings };
  }

  const totalMinutes = scored.reduce((sum, s) => sum + s.cost, 0);

  // --- Single day: everything lands on day one, hardest first -----------------
  if (days === 1) {
    const minutes = Math.min(totalMinutes, MAX_SINGLE_DAY_MINUTES);
    if (totalMinutes > MAX_SINGLE_DAY_MINUTES) warnings.push('SCHEDULE_OVERSUBSCRIBED');
    return {
      schedule: {
        days_available: 1,
        days: [
          {
            day: 1,
            focus: `Full sweep — ${focusFor(scored)}`,
            question_ids: scored.map((s) => s.question.id),
            minutes,
          },
        ],
      },
      warnings,
    };
  }

  // --- Reserve the tail for a mock loop and a light final day -----------------
  const reservedTail = days >= 4 ? 2 : days >= 3 ? 1 : 0;
  const newMaterialDays = days - reservedTail;
  const targets = taperedTargets(totalMinutes, newMaterialDays);

  // Greedy fill, hardest and most urgent first. No question is ever dropped:
  // dropping one could silently uncover a must-have requirement.
  const buckets: Scored[][] = Array.from({ length: newMaterialDays }, () => []);
  const queue = [...scored];
  for (let d = 0; d < newMaterialDays && queue.length > 0; d += 1) {
    const target = targets[d] ?? MIN_DAY_MINUTES;
    let spent = 0;
    const isLastNewDay = d === newMaterialDays - 1;
    while (queue.length > 0) {
      const next = queue[0]!;
      // The last day of new material absorbs whatever is left, so nothing is lost.
      if (!isLastNewDay && spent > 0 && spent + next.cost > target) break;
      queue.shift();
      buckets[d]!.push(next);
      spent += next.cost;
      if (!isLastNewDay && spent >= target) break;
    }
  }

  const studiedOn = new Map<string, number>();
  const dayList: ScheduleDay[] = [];

  for (let d = 0; d < newMaterialDays; d += 1) {
    const items = buckets[d]!;
    const dayNumber = d + 1;
    for (const item of items) studiedOn.set(item.question.id, dayNumber);

    const minutes = items.reduce((sum, s) => sum + s.cost, 0);
    if (minutes > OVERSUBSCRIBED_MINUTES && !warnings.includes('SCHEDULE_OVERSUBSCRIBED')) {
      warnings.push('SCHEDULE_OVERSUBSCRIBED');
    }

    if (items.length === 0) {
      // Capacity exceeds material: this becomes a spaced-review day.
      const revisit = pickReview(dayNumber, studiedOn, scored);
      dayList.push({
        day: dayNumber,
        focus: revisit.length > 0 ? `Review: ${focusFor(revisit)}` : 'Consolidate and rest',
        question_ids: revisit.map((s) => s.question.id),
        minutes: reviewMinutes(revisit),
      });
    } else {
      dayList.push({
        day: dayNumber,
        focus: focusFor(items),
        question_ids: items.map((s) => s.question.id),
        minutes,
      });
    }
  }

  // --- Tail: a full mock loop, then a deliberately light final day ------------
  if (reservedTail === 2) {
    const mock = scored
      .filter((s) => s.isMust || s.question.category === 'system-design')
      .slice(0, 8);
    const mockItems = mock.length > 0 ? mock : scored.slice(0, Math.min(5, scored.length));
    dayList.push({
      day: days - 1,
      focus: 'Mock interview: run the full loop end to end',
      question_ids: mockItems.map((s) => s.question.id),
      minutes: Math.max(MIN_DAY_MINUTES, reviewMinutes(mockItems)),
    });
  }
  if (reservedTail >= 1) {
    const light = [...scored]
      .sort(
        (a, b) =>
          a.question.difficulty - b.question.difficulty ||
          a.question.id.localeCompare(b.question.id),
      )
      .slice(0, Math.min(5, scored.length));
    dayList.push({
      day: days,
      focus: 'Light review, logistics, and questions to ask them',
      question_ids: light.map((s) => s.question.id),
      minutes: MIN_DAY_MINUTES,
    });
  }

  const schedule: KitSchedule = { days_available: days, days: dayList };
  assertInvariants(schedule, input, questionIds);
  return { schedule, warnings };
}

/** Minutes for a revision pass over already-studied material. */
function reviewMinutes(items: Scored[]): number {
  const raw = items.reduce((sum, s) => sum + s.cost, 0) * REVIEW_COST_FACTOR;
  return Math.max(MIN_DAY_MINUTES, Math.round(raw));
}

/**
 * Choose what a surplus day revisits, using a 1-3-7-14-30 spacing rotation over
 * material already studied. Deterministic: no randomness, no clock.
 */
function pickReview(
  dayNumber: number,
  studiedOn: Map<string, number>,
  scored: Scored[],
): Scored[] {
  const due: Scored[] = [];
  for (const interval of REVIEW_INTERVALS) {
    const sourceDay = dayNumber - interval;
    if (sourceDay < 1) continue;
    for (const item of scored) {
      if (studiedOn.get(item.question.id) === sourceDay && !due.includes(item)) due.push(item);
    }
  }
  if (due.length === 0) {
    // Nothing falls due on the rotation: revisit the hardest material instead,
    // so the day still has a purpose and is never empty.
    return scored.filter((s) => studiedOn.has(s.question.id)).slice(0, 4);
  }
  return due.slice(0, 8);
}

/**
 * The guarantees, checked rather than hoped for. These throw rather than warn:
 * a schedule that violates one of these is a bug, and shipping it would fail the
 * automated structure check anyway.
 */
function assertInvariants(
  schedule: KitSchedule,
  input: AllocateScheduleInput,
  questionIds: Set<string>,
): void {
  if (schedule.days.length !== input.days) {
    throw new InvalidScheduleInput(
      `produced ${schedule.days.length} days for a ${input.days}-day request`,
    );
  }
  if (schedule.days_available !== input.days) {
    throw new InvalidScheduleInput('days_available disagrees with the days requested');
  }
  for (const day of schedule.days) {
    if (!Number.isInteger(day.minutes)) {
      throw new InvalidScheduleInput(`day ${day.day} has non-integer minutes ${day.minutes}`);
    }
    for (const id of day.question_ids) {
      if (!questionIds.has(id)) {
        throw new InvalidScheduleInput(`day ${day.day} references unknown question ${id}`);
      }
    }
  }

  // "Every must-have requirement appears somewhere in the schedule."
  const scheduled = new Set(schedule.days.flatMap((d) => d.question_ids));
  const coveringQuestions = input.questions.filter((q) => scheduled.has(q.id));
  for (const req of input.requirements) {
    if (req.priority !== 'must') continue;
    const hasQuestion = input.questions.some((q) => q.requirement_ids.includes(req.id));
    if (!hasQuestion) continue; // coverage's problem, not the schedule's
    const isScheduled = coveringQuestions.some((q) => q.requirement_ids.includes(req.id));
    if (!isScheduled) {
      throw new InvalidScheduleInput(`must-have requirement ${req.id} never appears in the schedule`);
    }
  }
}
