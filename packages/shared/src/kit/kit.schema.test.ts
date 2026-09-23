import { describe, expect, it } from 'vitest';
import {
  KIT_TOP_LEVEL_KEYS,
  validateKit,
  validateKitForExport,
  type Kit,
} from './kit.schema.js';

/** A minimal kit that satisfies every Appendix A rule. Tests mutate clones of it. */
export function validKit(): Kit {
  return {
    source: {
      company: 'Acme Tools',
      company_url: 'https://acme.example',
      role: 'Senior Backend Engineer',
      location: 'Remote',
      jd_chars: 420,
      researched_at: '2026-09-23T09:00:00.000Z',
      pages_used: ['https://acme.example/', 'https://acme.example/careers'],
    },
    company_brief: {
      summary: 'Acme builds warehouse robotics.',
      what_they_do: 'They sell autonomous picking systems to logistics firms.',
      sources: ['https://acme.example/about'],
    },
    role: {
      title: 'Senior Backend Engineer',
      seniority: 'senior',
      responsibilities: ['Own the ingestion pipeline'],
      requirements: [
        { id: 'r1', text: '5+ years with Python', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'nice' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Walk me through a Python service you owned end to end.',
        answer_outline: 'Scope, architecture, a trade-off they got wrong, and the fix.',
        difficulty: 2,
      },
      {
        id: 'q2',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'Tell me about a time you unblocked a junior engineer.',
        answer_outline: 'STAR. Emphasis on what the other person learned.',
        difficulty: 1,
      },
    ],
    flashcards: [{ id: 'f1', front: 'GIL?', back: 'Global interpreter lock.', requirement_ids: ['r1'] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Python depth', question_ids: ['q1'], minutes: 60 },
        { day: 2, focus: 'Mentoring stories', question_ids: ['q2'], minutes: 45 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

function clone(): Kit {
  return structuredClone(validKit());
}

function firstIssue(result: ReturnType<typeof validateKit>): string {
  return result.ok ? '' : `${result.issues[0]?.path}: ${result.issues[0]?.message}`;
}

describe('Appendix A conformance', () => {
  it('accepts a well-formed kit', () => {
    const result = validateKit(validKit());
    expect(firstIssue(result)).toBe('');
    expect(result.ok).toBe(true);
  });

  it('exposes exactly the seven specified top-level keys, in order', () => {
    expect([...KIT_TOP_LEVEL_KEYS]).toEqual([
      'source',
      'company_brief',
      'role',
      'questions',
      'flashcards',
      'schedule',
      'coverage',
    ]);
    expect(Object.keys(validKit())).toEqual([...KIT_TOP_LEVEL_KEYS]);
  });

  it.each([
    ['source', 'company_url'],
    ['source', 'jd_chars'],
    ['source', 'pages_used'],
    ['company_brief', 'summary'],
    ['company_brief', 'sources'],
    ['role', 'requirements'],
    ['schedule', 'days_available'],
    ['coverage', 'passes'],
  ])('rejects a kit missing %s.%s', (section, field) => {
    const kit = clone() as unknown as Record<string, Record<string, unknown>>;
    delete kit[section]![field];
    expect(validateKit(kit).ok).toBe(false);
  });
});

describe('field constraints', () => {
  it.each([0, 4, 1.5, -1])('rejects difficulty %s', (difficulty) => {
    const kit = clone();
    kit.questions[0]!.difficulty = difficulty as 1 | 2 | 3;
    expect(validateKit(kit).ok).toBe(false);
  });

  it.each([1, 2, 3])('accepts difficulty %s', (difficulty) => {
    const kit = clone();
    kit.questions[0]!.difficulty = difficulty as 1 | 2 | 3;
    expect(validateKit(kit).ok).toBe(true);
  });

  it('rejects a string difficulty rather than coercing it', () => {
    const kit = clone();
    (kit.questions[0] as unknown as Record<string, unknown>).difficulty = '2';
    expect(validateKit(kit).ok).toBe(false);
  });

  it('rejects float minutes — durations are integer minutes, no floats', () => {
    const kit = clone();
    kit.schedule.days[0]!.minutes = 62.5;
    expect(validateKit(kit).ok).toBe(false);
  });

  it.each([
    ['kind', 'role.requirements[0].kind'],
    ['priority', 'role.requirements[0].priority'],
  ])('rejects an invalid %s enum', (field) => {
    const kit = clone();
    (kit.role.requirements[0] as unknown as Record<string, unknown>)[field] = 'bogus';
    expect(validateKit(kit).ok).toBe(false);
  });

  it('rejects the American spelling of behavioural', () => {
    const kit = clone();
    (kit.questions[1] as unknown as Record<string, unknown>).category = 'behavioral';
    expect(validateKit(kit).ok).toBe(false);
  });

  it('rejects the underscored spelling of system-design', () => {
    const kit = clone();
    (kit.questions[0] as unknown as Record<string, unknown>).category = 'system_design';
    expect(validateKit(kit).ok).toBe(false);
  });
});

describe('referential integrity', () => {
  it('rejects a schedule referencing a question that does not exist', () => {
    const kit = clone();
    kit.schedule.days[0]!.question_ids = ['q99'];
    const result = validateKit(kit);
    expect(result.ok).toBe(false);
    expect(firstIssue(result)).toContain('unknown question q99');
  });

  it('rejects a question referencing a requirement that does not exist', () => {
    const kit = clone();
    kit.questions[0]!.requirement_ids = ['r99'];
    expect(firstIssue(validateKit(kit))).toContain('unknown requirement r99');
  });

  it('rejects a flashcard referencing a requirement that does not exist', () => {
    const kit = clone();
    kit.flashcards[0]!.requirement_ids = ['r99'];
    expect(firstIssue(validateKit(kit))).toContain('unknown requirement r99');
  });

  it('rejects duplicate question ids', () => {
    const kit = clone();
    kit.questions[1]!.id = 'q1';
    expect(firstIssue(validateKit(kit))).toContain('duplicate ids');
  });

  it('rejects days_available disagreeing with the number of days', () => {
    const kit = clone();
    kit.schedule.days_available = 5;
    expect(firstIssue(validateKit(kit))).toContain('days_available is 5');
  });

  it('rejects non-ascending or non-1-based day numbers', () => {
    const kit = clone();
    kit.schedule.days[0]!.day = 2;
    kit.schedule.days[1]!.day = 1;
    expect(firstIssue(validateKit(kit))).toContain('ascending');
  });

  it('rejects coverage citing an unknown requirement', () => {
    const kit = clone();
    kit.coverage.uncovered_requirement_ids = ['r99'];
    expect(firstIssue(validateKit(kit))).toContain('unknown requirement r99');
  });
});

describe('lenient inbound vs strict outbound', () => {
  it('strips an unknown key when parsing model output', () => {
    const kit = { ...validKit(), _internalNote: 'from the model' };
    const result = validateKit(kit);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.kit)).toEqual([...KIT_TOP_LEVEL_KEYS]);
  });

  it('rejects an unknown top-level key on export — envelope leakage must not ship', () => {
    const kit = { ...validKit(), _state: { pinned: true } };
    expect(validateKitForExport(kit).ok).toBe(false);
  });

  it('rejects a leaked per-item envelope field on export', () => {
    const kit = clone() as unknown as { questions: Record<string, unknown>[] };
    kit.questions[0]!.pinned = true;
    expect(validateKitForExport(kit).ok).toBe(false);
  });

  it('accepts a clean kit on export', () => {
    expect(validateKitForExport(validKit()).ok).toBe(true);
  });
});
