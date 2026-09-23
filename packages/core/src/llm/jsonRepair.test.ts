import { describe, expect, it } from 'vitest';
import {
  extractBalancedJson,
  normaliseEnumValue,
  normaliseModelJson,
  parseModelJson,
  stripFences,
} from './jsonRepair.js';

describe('the spellings the specification insists on', () => {
  // The single highest-value repair in this file. The spec says `behavioural`
  // and `system-design`; models overwhelmingly say `behavioral` and
  // `system_design`. Without this, validation fails on most generation calls.
  it.each([
    ['behavioral', 'behavioural'],
    ['Behavioral', 'behavioural'],
    ['soft-skills', 'behavioural'],
    ['system_design', 'system-design'],
    ['system design', 'system-design'],
    ['SystemDesign', 'system-design'],
    ['company_fit', 'company-fit'],
    ['culture-fit', 'company-fit'],
    ['tech', 'technical'],
  ])('maps category %s to %s', (input, expected) => {
    expect(normaliseEnumValue(input)).toBe(expected);
  });

  it.each([
    ['must-have', 'must'],
    ['required', 'must'],
    ['mandatory', 'must'],
    ['nice-to-have', 'nice'],
    ['preferred', 'nice'],
    ['bonus', 'nice'],
    ['optional', 'nice'],
  ])('maps priority %s to %s', (input, expected) => {
    expect(normaliseEnumValue(input)).toBe(expected);
  });

  it('leaves a value the schema already accepts alone', () => {
    expect(normaliseEnumValue('behavioural')).toBe('behavioural');
    expect(normaliseEnumValue('system-design')).toBe('system-design');
    expect(normaliseEnumValue('must')).toBe('must');
  });

  it('repairs enums in place inside a nested structure', () => {
    const repaired = normaliseModelJson({
      questions: [{ category: 'behavioral', difficulty: '2' }],
      role: { requirements: [{ kind: 'domain-specific', priority: 'must-have' }] },
    }) as {
      questions: { category: string; difficulty: number }[];
      role: { requirements: { kind: string; priority: string }[] };
    };
    expect(repaired.questions[0]!.category).toBe('behavioural');
    expect(repaired.questions[0]!.difficulty).toBe(2);
    expect(repaired.role.requirements[0]!.kind).toBe('domain');
    expect(repaired.role.requirements[0]!.priority).toBe('must');
  });
});

describe('numbers the schema needs as integers', () => {
  it('coerces a quoted difficulty', () => {
    expect((normaliseModelJson({ difficulty: '3' }) as { difficulty: number }).difficulty).toBe(3);
  });

  it('rounds a float minutes value rather than failing validation on it', () => {
    expect((normaliseModelJson({ minutes: 62.5 }) as { minutes: number }).minutes).toBe(63);
  });

  it('leaves a non-numeric value for the schema to reject', () => {
    expect((normaliseModelJson({ minutes: 'about an hour' }) as { minutes: unknown }).minutes).toBe(
      'about an hour',
    );
  });
});

describe('arrays the model sometimes sends as a bare string', () => {
  it('wraps a single requirement id', () => {
    const out = normaliseModelJson({ requirement_ids: 'r1' }) as { requirement_ids: string[] };
    expect(out.requirement_ids).toEqual(['r1']);
  });

  it('turns null into an empty array', () => {
    const out = normaliseModelJson({ requirement_ids: null }) as { requirement_ids: string[] };
    expect(out.requirement_ids).toEqual([]);
  });

  it('leaves a proper array alone', () => {
    const out = normaliseModelJson({ requirement_ids: ['r1', 'r2'] }) as {
      requirement_ids: string[];
    };
    expect(out.requirement_ids).toEqual(['r1', 'r2']);
  });
});

describe('fences and surrounding prose', () => {
  it('unwraps a json code fence', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('unwraps a bare code fence', () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text untouched', () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('balanced extraction', () => {
  it('pulls the object out of a friendly explanation', () => {
    const text = 'Here is the JSON you asked for:\n{"a":1}\nLet me know if you need changes.';
    expect(extractBalancedJson(text)).toBe('{"a":1}');
  });

  it('is not fooled by a brace inside a string', () => {
    const text = '{"prompt":"What does } mean in this context?","b":2}';
    expect(extractBalancedJson(text)).toBe(text);
  });

  it('is not fooled by an escaped quote', () => {
    const text = '{"prompt":"He said \\"go\\" and left","b":2}';
    expect(extractBalancedJson(text)).toBe(text);
  });

  it('handles a top-level array', () => {
    expect(extractBalancedJson('noise [1,2,3] more noise')).toBe('[1,2,3]');
  });

  it('returns null when there is nothing to find', () => {
    expect(extractBalancedJson('no json here')).toBeNull();
  });
});

describe('the ladder as a whole', () => {
  it('parses clean JSON on the first rung', () => {
    const out = parseModelJson('{"a":1}');
    expect(out.ok).toBe(true);
    expect(out.rung).toBe('direct');
  });

  it('recovers fenced JSON', () => {
    const out = parseModelJson('```json\n{"a":1}\n```');
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ a: 1 });
  });

  it('recovers JSON followed by commentary', () => {
    const out = parseModelJson('{"a":1}\n\nI hope this helps!');
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ a: 1 });
  });

  it('recovers from a trailing comma', () => {
    const out = parseModelJson('{"a":1,}');
    expect(out.ok).toBe(true);
    expect(out.rung).toBe('repaired');
  });

  it('recovers from a truncated tail', () => {
    const out = parseModelJson('{"questions":[{"id":"q1","prompt":"why"}');
    expect(out.ok).toBe(true);
    expect(out.value).toHaveProperty('questions');
  });

  it('normalises enums while it parses', () => {
    const out = parseModelJson('{"category":"system_design"}');
    expect(out.value).toEqual({ category: 'system-design' });
  });

  it('reports failure rather than throwing, so the caller can fall back', () => {
    // An empty generation is a real measured outcome: the model spends its whole
    // output budget on reasoning and returns nothing.
    const out = parseModelJson('');
    expect(out.ok).toBe(false);
    expect(out.rung).toBe('none');
  });

  it('reports failure on prose with no JSON at all', () => {
    expect(parseModelJson('I cannot help with that request.').ok).toBe(false);
  });
});

describe('a refusal is a failed call, not a value', () => {
  // The tolerant parser will happily turn prose into a valid JSON *string*.
  // Accepting that would hand a bare string downstream as though it were a kit.
  it.each([
    'I cannot help with that request.',
    'null',
    '42',
    '"just a string"',
    'true',
  ])('rejects %s as unstructured', (input) => {
    expect(parseModelJson(input).ok).toBe(false);
  });

  it('still accepts a legitimate top-level array', () => {
    expect(parseModelJson('[{"id":"q1"}]').ok).toBe(true);
  });
});
