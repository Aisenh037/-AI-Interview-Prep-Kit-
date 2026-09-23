import { describe, expect, it } from 'vitest';
import { LlmRouter } from '../llm/router.js';
import { createFixtureProvider } from '../llm/providers/fixture.js';
import {
  evidenceAppearsIn,
  extractRequirements,
  fallbackExtraction,
  finalise,
  priorityFromWording,
  type Extraction,
} from './extractRequirements.js';

const JD = `Senior Backend Engineer
Remote (UK)

Requirements:
- 5+ years building production services in Python
- Must have deep PostgreSQL experience including query tuning
- Experience mentoring junior engineers

Nice to have:
- Exposure to Kubernetes
- Familiarity with the logistics domain`;

function routerReturning(payload: unknown): LlmRouter {
  return new LlmRouter([createFixtureProvider({ respond: JSON.stringify(payload) })]);
}

function draft(requirements: Extraction['requirements']): Extraction {
  return {
    role_title: 'Senior Backend Engineer',
    seniority: 'senior',
    location: 'Remote (UK)',
    responsibilities: [],
    requirements,
  };
}

describe('nothing is invented', () => {
  it('drops a requirement whose evidence is not in the posting', async () => {
    // The failure this guards against: a model producing plausible-sounding
    // requirements a posting never mentioned. Precision is scored, not recall.
    const router = routerReturning(
      draft([
        {
          text: '5+ years with Python',
          kind: 'technical',
          priority: 'must',
          evidence: '5+ years building production services in Python',
        },
        {
          text: 'Experience with Kafka',
          kind: 'technical',
          priority: 'must',
          evidence: 'Strong experience with Kafka and event streaming',
        },
      ]),
    );

    const role = await extractRequirements({ jd: JD, router });
    expect(role.requirements.map((r) => r.text)).toEqual(['5+ years with Python']);
    expect(role.rejected[0]?.text).toBe('Experience with Kafka');
    expect(role.warnings).toContain('REQUIREMENTS_REJECTED_UNEVIDENCED');
  });

  it('keeps a requirement whose evidence was re-wrapped but is genuinely present', () => {
    // Models re-flow whitespace and drop bullet characters while quoting
    // faithfully; that should not be treated as invention.
    expect(evidenceAppearsIn(JD, '5+  years building   production services in Python')).toBe(true);
    expect(evidenceAppearsIn(JD, '- Must have deep PostgreSQL experience')).toBe(true);
  });

  it('rejects an evidence span that only shares a word or two', () => {
    expect(evidenceAppearsIn(JD, 'Strong experience with Kafka and event streaming')).toBe(false);
    expect(evidenceAppearsIn(JD, 'Rust and WebAssembly toolchains')).toBe(false);
  });

  it('drops a near-duplicate rather than counting it twice', async () => {
    const router = routerReturning(
      draft([
        {
          text: '5+ years building production services in Python',
          kind: 'technical',
          priority: 'must',
          evidence: '5+ years building production services in Python',
        },
        {
          text: '5+ years building production services in Python',
          kind: 'technical',
          priority: 'must',
          evidence: '5+ years building production services in Python',
        },
      ]),
    );
    const role = await extractRequirements({ jd: JD, router });
    expect(role.requirements).toHaveLength(1);
  });
});

describe('must and nice are taken from how the posting words it', () => {
  it('reads priority from the section a line sits under', () => {
    expect(priorityFromWording(JD, 'Exposure to Kubernetes', 'must')).toBe('nice');
    expect(priorityFromWording(JD, '5+ years building production services in Python', 'nice')).toBe(
      'must',
    );
  });

  it('lets wording on the line beat the heading above it', () => {
    const jd = `Requirements:\n- Kubernetes experience (nice to have)`;
    expect(priorityFromWording(jd, 'Kubernetes experience (nice to have)', 'must')).toBe('nice');
  });

  it('overrides the model when it flattens the distinction', async () => {
    // A "required" line and a "bonus points for" line are not the same thing,
    // and models routinely mark everything must.
    const router = routerReturning(
      draft([
        {
          text: 'Exposure to Kubernetes',
          kind: 'technical',
          priority: 'must',
          evidence: 'Exposure to Kubernetes',
        },
      ]),
    );
    const role = await extractRequirements({ jd: JD, router });
    expect(role.requirements[0]!.priority).toBe('nice');
  });
});

describe('ids belong to us', () => {
  it('mints sequential ids regardless of what the model sent', () => {
    const role = finalise(
      JD,
      draft([
        { text: 'Python', kind: 'technical', priority: 'must', evidence: 'Python' },
        { text: 'PostgreSQL', kind: 'technical', priority: 'must', evidence: 'PostgreSQL' },
      ]),
      [],
    );
    expect(role.requirements.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('leaves no gaps after a rejection, so ids stay contiguous', () => {
    const role = finalise(
      JD,
      draft([
        { text: 'Invented', kind: 'technical', priority: 'must', evidence: 'nowhere in the text' },
        { text: 'Python', kind: 'technical', priority: 'must', evidence: 'Python' },
      ]),
      [],
    );
    expect(role.requirements.map((r) => r.id)).toEqual(['r1']);
  });
});

describe('a two-line posting produces a thin kit that says so', () => {
  const STUB = 'Frontend dev needed. React.';

  it('flags the posting as thin', async () => {
    const router = routerReturning(
      draft([{ text: 'React', kind: 'technical', priority: 'must', evidence: 'React' }]),
    );
    const role = await extractRequirements({ jd: STUB, router });
    expect(role.warnings).toContain('JD_TOO_SHORT');
    expect(role.requirements).toHaveLength(1);
  });

  it('does not pad a stub with requirements it never stated', async () => {
    const router = routerReturning(
      draft([
        { text: 'React', kind: 'technical', priority: 'must', evidence: 'React' },
        {
          text: 'Strong communication skills',
          kind: 'behavioural',
          priority: 'must',
          evidence: 'Excellent written and verbal communication',
        },
        {
          text: 'Experience with agile',
          kind: 'domain',
          priority: 'must',
          evidence: 'Comfortable working in an agile team',
        },
      ]),
    );
    const role = await extractRequirements({ jd: STUB, router });
    expect(role.requirements.map((r) => r.text)).toEqual(['React']);
    expect(role.rejected).toHaveLength(2);
  });

  it('reports an empty posting rather than guessing at one', async () => {
    const role = await extractRequirements({ jd: '   ', router: routerReturning(draft([])) });
    expect(role.requirements).toEqual([]);
    expect(role.warnings).toContain('JD_EMPTY');
  });
});

describe('the deterministic path', () => {
  it('selects lines from the posting and classifies them', () => {
    const extraction = fallbackExtraction(JD);
    const texts = extraction.requirements.map((r) => r.text);
    expect(texts.some((t) => t.includes('Python'))).toBe(true);
    expect(texts.some((t) => t.includes('Kubernetes'))).toBe(true);

    const kubernetes = extraction.requirements.find((r) => r.text.includes('Kubernetes'));
    expect(kubernetes?.priority).toBe('nice');
    const mentoring = extraction.requirements.find((r) => r.text.includes('mentoring'));
    expect(mentoring?.kind).toBe('behavioural');
  });

  it('cannot invent, because it can only select existing lines', () => {
    const extraction = fallbackExtraction(JD);
    for (const requirement of extraction.requirements) {
      expect(JD).toContain(requirement.text);
    }
  });

  it('returns nothing for a posting that states nothing', () => {
    expect(fallbackExtraction('We are hiring!').requirements).toEqual([]);
  });

  it('is used when the model is unavailable, and says so', async () => {
    const router = new LlmRouter(
      [createFixtureProvider({ failFirst: 99, failure: { code: 'SERVER' } })],
      { random: () => 0.5 },
    );
    const role = await extractRequirements({ jd: JD, router });
    expect(role.warnings).toContain('EXTRACTION_USED_FALLBACK');
    expect(role.requirements.length).toBeGreaterThan(0); // still produced a kit
  });
});
