import { describe, expect, it } from 'vitest';
import type { Question, Requirement } from '@kit/shared';
import {
  computeCoverage,
  keyTerms,
  MAX_COVERAGE_PASSES,
  shouldStopCoverageLoop,
} from './computeCoverage.js';

function req(id: string, text: string, priority: 'must' | 'nice' = 'must'): Requirement {
  return { id, text, kind: 'technical', priority };
}

function question(id: string, requirementIds: string[], prompt: string, outline = ''): Question {
  return {
    id,
    requirement_ids: requirementIds,
    category: 'technical',
    prompt,
    answer_outline: outline,
    difficulty: 2,
  };
}

describe('key term extraction', () => {
  it('drops filler that would otherwise match every question', () => {
    const terms = keyTerms('5+ years of strong hands-on experience with Kafka');
    expect(terms.has('kafka')).toBe(true);
    expect(terms.has('years')).toBe(false);
    expect(terms.has('experience')).toBe(false);
    expect(terms.has('strong')).toBe(false);
  });

  it('maps vocabulary that differs in surface form but not in meaning', () => {
    expect(keyTerms('k8s').has('kubernetes')).toBe(true);
    expect(keyTerms('Postgres').has('postgresql')).toBe(true);
    expect(keyTerms('ReactJS').has('react')).toBe(true);
    expect(keyTerms('mentoring junior engineers').has('mentor')).toBe(true);
  });
});

describe('gap detection', () => {
  it('reports a requirement with no question against it', () => {
    const requirements = [req('r1', 'Kafka streaming'), req('r2', 'Terraform modules')];
    const questions = [question('q1', ['r1'], 'How would you tune a Kafka consumer group?')];
    const result = computeCoverage(requirements, questions);
    expect(result.uncovered).toEqual(['r2']);
    expect(result.uncoveredMusts).toEqual(['r2']);
  });

  it('reports nothing uncovered when every requirement has a real question', () => {
    const requirements = [req('r1', 'Kafka streaming'), req('r2', 'Terraform modules')];
    const questions = [
      question('q1', ['r1'], 'How would you tune a Kafka consumer group for throughput?'),
      question('q2', ['r2'], 'Describe how you structure reusable Terraform modules.'),
    ];
    expect(computeCoverage(requirements, questions).uncovered).toEqual([]);
  });

  it('separates nice-to-have gaps from must-have gaps', () => {
    const requirements = [req('r1', 'Kafka streaming', 'nice'), req('r2', 'Rust', 'must')];
    const result = computeCoverage(requirements, []);
    expect(result.uncovered).toEqual(['r1', 'r2']);
    expect(result.uncoveredMusts).toEqual(['r2']);
  });

  it('terminates on a posting with no requirements at all', () => {
    const result = computeCoverage([], []);
    expect(result.uncovered).toEqual([]);
    expect(result.uncoveredMusts).toEqual([]);
  });
});

describe('verify down — fictitious coverage is not coverage', () => {
  it('discards a requirement id the model invented', () => {
    const requirements = [req('r1', 'Kafka streaming')];
    const questions = [question('q1', ['r1', 'r9'], 'How would you tune a Kafka consumer group?')];
    const result = computeCoverage(requirements, questions);
    expect(result.questions[0]!.requirement_ids).toEqual(['r1']);
    expect(result.corrections[0]!.droppedClaims).toContain('r9');
  });

  it('refuses a claim where the question shares no vocabulary with the requirement', () => {
    const requirements = [req('r1', 'Kafka streaming'), req('r2', 'Terraform modules')];
    // The model stapled r2 onto a question that is plainly about Kafka.
    const questions = [question('q1', ['r1', 'r2'], 'How would you tune a Kafka consumer group?')];
    const result = computeCoverage(requirements, questions);
    expect(result.questions[0]!.requirement_ids).toEqual(['r1']);
    expect(result.uncoveredMusts).toEqual(['r2']);
  });

  it('does not count a stub prompt as coverage', () => {
    const requirements = [req('r1', 'Kafka streaming')];
    const questions = [question('q1', ['r1'], 'Kafka?')];
    expect(computeCoverage(requirements, questions).uncoveredMusts).toEqual(['r1']);
  });

  it('trusts the claim when the requirement text is entirely filler', () => {
    const requirements = [req('r1', 'strong experience')];
    const questions = [question('q1', ['r1'], 'Tell me about the hardest project you shipped.')];
    expect(computeCoverage(requirements, questions).uncovered).toEqual([]);
  });
});

describe('link up — coverage the model forgot to declare', () => {
  it('attaches a requirement a question plainly addresses', () => {
    const requirements = [req('r1', 'Kubernetes cluster operations')];
    const questions = [
      question('q1', [], 'Walk me through debugging a failing Kubernetes cluster rollout.'),
    ];
    const result = computeCoverage(requirements, questions);
    expect(result.questions[0]!.requirement_ids).toEqual(['r1']);
    expect(result.corrections[0]!.addedLinks).toContain('r1');
    expect(result.uncovered).toEqual([]);
  });

  it('requires two matching terms before inferring a link, not one', () => {
    const requirements = [req('r1', 'Kubernetes cluster operations')];
    const questions = [question('q1', [], 'What is your favourite cluster of ideas?')];
    expect(computeCoverage(requirements, questions).uncovered).toEqual(['r1']);
  });
});

describe('output is safe to persist', () => {
  it('never emits a requirement_id that does not exist', () => {
    const requirements = [req('r1', 'Kafka streaming')];
    const questions = [question('q1', ['r1', 'r9', 'nonsense'], 'Tune a Kafka consumer group.')];
    const ids = new Set(requirements.map((r) => r.id));
    for (const q of computeCoverage(requirements, questions).questions) {
      for (const rid of q.requirement_ids) expect(ids.has(rid)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const requirements = [req('r1', 'Kafka streaming'), req('r2', 'Terraform modules')];
    const questions = [question('q1', ['r2', 'r1'], 'Kafka consumer groups and Terraform modules')];
    const a = computeCoverage(requirements, questions);
    const b = computeCoverage(requirements, questions);
    expect(JSON.stringify(a.questions)).toBe(JSON.stringify(b.questions));
  });
});

describe('the loop stops', () => {
  it('stops as soon as every must-have is covered', () => {
    expect(
      shouldStopCoverageLoop({ passesRun: 1, uncoveredMusts: [], previousUncoveredMusts: null }),
    ).toEqual({ stop: true, reason: 'covered' });
  });

  it('stops at the pass ceiling', () => {
    expect(
      shouldStopCoverageLoop({
        passesRun: MAX_COVERAGE_PASSES,
        uncoveredMusts: ['r1'],
        previousUncoveredMusts: ['r2'],
      }),
    ).toEqual({ stop: true, reason: 'max-passes' });
  });

  it('stops when a pass made no progress, rather than spending another', () => {
    expect(
      shouldStopCoverageLoop({
        passesRun: 2,
        uncoveredMusts: ['r1', 'r2'],
        previousUncoveredMusts: ['r1', 'r2'],
      }),
    ).toEqual({ stop: true, reason: 'no-progress' });
  });

  it('continues while gaps remain and progress is being made', () => {
    expect(
      shouldStopCoverageLoop({
        passesRun: 1,
        uncoveredMusts: ['r1'],
        previousUncoveredMusts: ['r1', 'r2'],
      }),
    ).toEqual({ stop: false, reason: 'continue' });
  });
});
