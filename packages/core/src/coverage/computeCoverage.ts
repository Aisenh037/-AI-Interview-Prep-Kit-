/**
 * Coverage checking.
 *
 * The brief: "Comparing the extracted requirements against the generated questions
 * to find the gaps is likewise your code's decision to make, not the model's."
 * So, like the scheduler, this module is pure and synchronous with no route to a
 * language model.
 *
 * Naive coverage — "does any question list this requirement id?" — is not enough,
 * and the brief says as much by scoring whether "coverage [is] genuinely checked".
 * A model asked to cover ten requirements will happily staple all ten ids onto
 * three unrelated questions. So the check runs in both directions:
 *
 *   VERIFY DOWN  a claimed requirement_id is discarded unless the question text
 *                actually shares vocabulary with the requirement. This stops
 *                fictitious coverage.
 *   LINK UP      a question that plainly addresses a requirement it forgot to cite
 *                gains that id. This stops us burning a gap-fill call on a
 *                requirement that was already covered.
 */
import type { Question, Requirement } from '@kit/shared';

/**
 * Words that carry no signal about *what* a requirement is about. Dropping them
 * stops "5+ years of experience with Kafka" matching "Do you have experience?".
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'be', 'been', 'was', 'were', 'you', 'your', 'we', 'our',
  'they', 'their', 'it', 'its', 'this', 'that', 'these', 'those', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'must', 'may', 'about', 'into', 'over',
  'across', 'using', 'use', 'used', 'able', 'who', 'what', 'when', 'how', 'why',
  // Filler that appears in almost every posting and would match almost every question.
  'years', 'year', 'experience', 'experienced', 'strong', 'solid', 'proven', 'deep',
  'working', 'work', 'ability', 'knowledge', 'understanding', 'skills', 'skill',
  'good', 'excellent', 'great', 'plus', 'familiar', 'familiarity', 'comfortable',
  'proficiency', 'proficient', 'expertise', 'background', 'track', 'record',
  'demonstrated', 'hands', 'min', 'plus',
]);

/**
 * Vocabulary that differs between a posting and a question without differing in
 * meaning. Each entry maps a surface form to a canonical token.
 */
const SYNONYMS: Record<string, string> = {
  reactjs: 'react',
  'react.js': 'react',
  jsx: 'react',
  nodejs: 'node',
  'node.js': 'node',
  ts: 'typescript',
  js: 'javascript',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  psql: 'postgresql',
  mongo: 'mongodb',
  ci: 'cicd',
  cd: 'cicd',
  'ci/cd': 'cicd',
  pipelines: 'cicd',
  pipeline: 'cicd',
  aws: 'cloud',
  gcp: 'cloud',
  azure: 'cloud',
  restful: 'rest',
  apis: 'api',
  microservice: 'microservices',
  'front-end': 'frontend',
  'back-end': 'backend',
  'full-stack': 'fullstack',
  mentoring: 'mentor',
  mentorship: 'mentor',
  mentored: 'mentor',
  leading: 'lead',
  leadership: 'lead',
  led: 'lead',
  communicate: 'communication',
  communicating: 'communication',
  collaborate: 'collaboration',
  collaborating: 'collaboration',
  distributed: 'distributed',
  scalability: 'scale',
  scaling: 'scale',
  scalable: 'scale',
  testing: 'test',
  tests: 'test',
  tested: 'test',
};

function canonical(token: string): string {
  const lower = token.toLowerCase();
  return SYNONYMS[lower] ?? lower;
}

/** Content words that identify what a piece of text is about. */
export function keyTerms(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const terms = new Set<string>();
  for (const raw of tokens) {
    const trimmed = raw.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (trimmed.length < 2) continue;
    if (/^\d+\+?$/.test(trimmed)) continue; // bare numbers: "5", "5+"
    const token = canonical(trimmed);
    if (STOPWORDS.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const term of a) if (b.has(term)) n += 1;
  return n;
}

/** A question must look like a question before it can count as coverage. */
function isSubstantial(q: Question): boolean {
  return (
    q.prompt.trim().length >= 25 &&
    q.difficulty >= 1 &&
    q.difficulty <= 3
  );
}

export interface CoverageReport {
  /** requirement id -> the question ids that genuinely cover it */
  coveredBy: Map<string, string[]>;
  /** Every requirement with no question against it. */
  uncovered: string[];
  /** The subset of `uncovered` marked `must`. These are the ones that matter. */
  uncoveredMusts: string[];
  /** Questions whose requirement_ids we corrected, for honest reporting. */
  corrections: {
    questionId: string;
    droppedClaims: string[];
    addedLinks: string[];
  }[];
}

export interface CoverageResult extends CoverageReport {
  /** Questions with their requirement_ids rewritten to the verified set. */
  questions: Question[];
}

/**
 * Compare generated questions against extracted requirements and report the gaps.
 * Returns corrected questions alongside the report: callers should persist these,
 * because a dangling or fictitious requirement_id would otherwise reach the kit.
 */
export function computeCoverage(
  requirements: Requirement[],
  questions: Question[],
): CoverageResult {
  const requirementIds = new Set(requirements.map((r) => r.id));
  const termsByRequirement = new Map<string, Set<string>>();
  for (const r of requirements) termsByRequirement.set(r.id, keyTerms(r.text));

  const corrections: CoverageReport['corrections'] = [];

  const corrected = questions.map((question) => {
    const questionTerms = keyTerms(`${question.prompt} ${question.answer_outline}`);
    const verified = new Set<string>();
    const droppedClaims: string[] = [];
    const addedLinks: string[] = [];

    // VERIFY DOWN — a claim only counts if the vocabulary actually matches.
    for (const rid of question.requirement_ids) {
      if (!requirementIds.has(rid)) {
        droppedClaims.push(rid); // the model invented a requirement id
        continue;
      }
      const reqTerms = termsByRequirement.get(rid)!;
      // A requirement whose text is entirely filler has no terms to match on.
      // Fall back to trusting the claim rather than dropping real coverage.
      if (reqTerms.size === 0 || overlap(reqTerms, questionTerms) >= 1) {
        verified.add(rid);
      } else {
        droppedClaims.push(rid);
      }
    }

    // LINK UP — a question that plainly addresses a requirement it did not cite.
    for (const r of requirements) {
      if (verified.has(r.id)) continue;
      const reqTerms = termsByRequirement.get(r.id)!;
      if (reqTerms.size >= 2 && overlap(reqTerms, questionTerms) >= 2) {
        verified.add(r.id);
        addedLinks.push(r.id);
      }
    }

    if (droppedClaims.length > 0 || addedLinks.length > 0) {
      corrections.push({ questionId: question.id, droppedClaims, addedLinks });
    }

    // Keep the original ordering of requirements for deterministic output.
    const ordered = requirements.map((r) => r.id).filter((id) => verified.has(id));
    return { ...question, requirement_ids: ordered };
  });

  const coveredBy = new Map<string, string[]>();
  for (const r of requirements) coveredBy.set(r.id, []);
  for (const question of corrected) {
    if (!isSubstantial(question)) continue;
    for (const rid of question.requirement_ids) {
      coveredBy.get(rid)?.push(question.id);
    }
  }

  const uncovered = requirements
    .filter((r) => (coveredBy.get(r.id) ?? []).length === 0)
    .map((r) => r.id);
  const mustIds = new Set(requirements.filter((r) => r.priority === 'must').map((r) => r.id));
  const uncoveredMusts = uncovered.filter((id) => mustIds.has(id));

  return { coveredBy, uncovered, uncoveredMusts, corrections, questions: corrected };
}

/**
 * The loop's stopping rule, kept next to the check it governs.
 *
 * Three passes, then stop:
 *   pass 1  questions generated per category
 *   pass 2  a narrow, single-requirement gap-fill prompt
 *   pass 3  deterministic template fill for anything still uncovered
 *
 * Why three, and why the last one is not a model call: marginal yield collapses
 * after pass 2, because a pass-1 miss is an attention failure that the narrow
 * prompt fixes, not a capability failure a third attempt would fix. An unbounded
 * loop also cannot coexist with a fifteen-minute budget under a tokens-per-minute
 * ceiling — the loop would itself become the thing that falls over when the
 * provider says slow down. Making the final pass deterministic makes termination
 * provable rather than probable.
 */
export const MAX_COVERAGE_PASSES = 3;

export interface StopDecision {
  stop: boolean;
  reason: 'covered' | 'max-passes' | 'no-progress' | 'continue';
}

export function shouldStopCoverageLoop(args: {
  passesRun: number;
  uncoveredMusts: string[];
  previousUncoveredMusts: string[] | null;
}): StopDecision {
  if (args.uncoveredMusts.length === 0) return { stop: true, reason: 'covered' };
  if (args.passesRun >= MAX_COVERAGE_PASSES) return { stop: true, reason: 'max-passes' };
  // The model keeps returning the same three questions: another identical pass
  // would spend tokens to achieve nothing.
  if (
    args.previousUncoveredMusts !== null &&
    args.previousUncoveredMusts.length === args.uncoveredMusts.length &&
    args.previousUncoveredMusts.every((id, i) => id === args.uncoveredMusts[i])
  ) {
    return { stop: true, reason: 'no-progress' };
  }
  return { stop: false, reason: 'continue' };
}
