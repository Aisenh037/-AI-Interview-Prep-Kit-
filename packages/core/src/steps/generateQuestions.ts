/**
 * Generating the question bank, one call per category, then closing the gaps.
 *
 * Three passes, and the third one does not involve a model:
 *
 *   1. One call per category, with that category's own prompt and its own share
 *      of the requirements.
 *   2. A narrow gap-fill call per uncovered must-have — one requirement in
 *      isolation, which closes nearly every remaining gap because a pass-one
 *      miss is an attention failure rather than a capability failure.
 *   3. A deterministic template built from the requirement's own words, for
 *      anything still uncovered.
 *
 * Pass three is why "a kit that ships with uncovered must-have requirements has
 * failed at the one job it had" is a guarantee here rather than a hope. It is
 * also why a fourth model pass would buy nothing.
 */
import { z } from 'zod';
import type { Question, QuestionCategory, Requirement } from '@kit/shared';
import type { LlmRouter } from '../llm/router.js';
import { computeCoverage, shouldStopCoverageLoop } from '../coverage/computeCoverage.js';
import { QUESTION_PROMPTS, gapFillPrompt, type InterviewContext } from '../prompts/questionPrompts.js';
import type { GenerationPlan } from '../pipeline/planCategories.js';

const DraftQuestion = z.object({
  prompt: z.string().min(10).max(600),
  answer_outline: z.string().max(1200),
  requirement_ids: z.array(z.string()),
  difficulty: z.int().min(1).max(3),
});

const QuestionBatch = z.object({ questions: z.array(DraftQuestion) });
type QuestionBatch = z.infer<typeof QuestionBatch>;

export interface GenerateQuestionsInput {
  plan: GenerationPlan;
  requirements: Requirement[];
  context: InterviewContext;
  roleTitle: string;
  seniority: string;
  nonce: string;
  router: LlmRouter;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateQuestionsResult {
  questions: Question[];
  /** Number of generation passes actually run: 1, 2 or 3. Reported honestly. */
  passes: number;
  uncovered: string[];
  warnings: string[];
}

export async function generateQuestions(
  input: GenerateQuestionsInput,
): Promise<GenerateQuestionsResult> {
  const warnings: string[] = [];
  const collected: { draft: z.infer<typeof DraftQuestion>; category: QuestionCategory }[] = [];

  // --- pass 1: one call per category ----------------------------------------
  for (const categoryPlan of input.plan.plans) {
    const builder = QUESTION_PROMPTS[categoryPlan.category];
    const { system, user } = builder({
      nonce: input.nonce,
      requirements: categoryPlan.requirements,
      context: input.context,
      roleTitle: input.roleTitle,
      seniority: input.seniority,
      perRequirement: categoryPlan.perRequirement,
    });

    const result = await input.router.callStructured<QuestionBatch>({
      callClass: 'questions',
      schemaName: `questions_${categoryPlan.category.replace('-', '_')}`,
      schema: QuestionBatch,
      system,
      user,
      maxOutputTokens: 3500,
      fallback: () => ({
        questions: templatesFor(categoryPlan.requirements, categoryPlan.category),
      }),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    if (result.origin === 'fallback') {
      warnings.push(`QUESTIONS_TEMPLATED:${categoryPlan.category}`);
    }
    for (const draft of result.value.questions) {
      collected.push({ draft, category: categoryPlan.category });
    }
  }

  let questions = mint(collected, input.requirements);
  let coverage = computeCoverage(input.requirements, questions);
  questions = coverage.questions;
  let passes = 1;
  let previousUncovered: string[] | null = null;

  // --- passes 2 and 3: close the gaps ---------------------------------------
  for (;;) {
    const decision = shouldStopCoverageLoop({
      passesRun: passes,
      uncoveredMusts: coverage.uncoveredMusts,
      previousUncoveredMusts: previousUncovered,
    });
    if (decision.stop) {
      if (decision.reason === 'no-progress') warnings.push('COVERAGE_LOOP_NO_PROGRESS');
      break;
    }

    previousUncovered = [...coverage.uncoveredMusts];
    passes += 1;

    const gaps = input.requirements.filter((r) => coverage.uncoveredMusts.includes(r.id));
    const additions: { draft: z.infer<typeof DraftQuestion>; category: QuestionCategory }[] = [];

    for (const requirement of gaps) {
      const category = categoryForRequirement(requirement, input.context);

      // The final pass is deterministic: no model call, so termination is provable.
      if (passes >= 3) {
        for (const template of templatesFor([requirement], category)) {
          additions.push({ draft: template, category });
        }
        continue;
      }

      const { system, user } = gapFillPrompt(input.nonce, requirement, category, input.context);
      const result = await input.router.callStructured<QuestionBatch>({
        callClass: 'gapfill',
        schemaName: 'gap_questions',
        schema: QuestionBatch,
        system,
        user,
        maxOutputTokens: 1500,
        fallback: () => ({ questions: templatesFor([requirement], category) }),
        ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      for (const draft of result.value.questions) additions.push({ draft, category });
    }

    if (additions.length === 0) break;

    collected.push(...additions);
    questions = mint(collected, input.requirements);
    coverage = computeCoverage(input.requirements, questions);
    questions = coverage.questions;
  }

  if (coverage.uncoveredMusts.length > 0) {
    // Reported, never hidden. Deleting the requirement to empty the array would
    // be the actual failure.
    warnings.push('COVERAGE_INCOMPLETE');
  }

  return { questions, passes, uncovered: coverage.uncovered, warnings };
}

/** Which category best probes a given requirement when filling a gap. */
function categoryForRequirement(
  requirement: Requirement,
  context: InterviewContext,
): QuestionCategory {
  if (requirement.kind === 'behavioural') return 'behavioural';
  if (requirement.kind === 'domain') return 'company-fit';
  if (context.signals.systemDesign && /architect|scal|distributed|design/i.test(requirement.text)) {
    return 'system-design';
  }
  return 'technical';
}

/**
 * Assign ids and drop references the model invented.
 *
 * Ids are ours. Numbering here rather than trusting the model is what keeps the
 * schedule's question_ids valid and stable.
 */
function mint(
  collected: { draft: z.infer<typeof DraftQuestion>; category: QuestionCategory }[],
  requirements: Requirement[],
): Question[] {
  const known = new Set(requirements.map((r) => r.id));
  const seen = new Set<string>();
  const questions: Question[] = [];

  for (const { draft, category } of collected) {
    const prompt = draft.prompt.trim();
    const key = prompt.toLowerCase().replace(/\s+/g, ' ');
    if (prompt === '' || seen.has(key)) continue;
    seen.add(key);

    questions.push({
      id: `q${questions.length + 1}`,
      requirement_ids: draft.requirement_ids.filter((id) => known.has(id)),
      category,
      prompt,
      answer_outline: draft.answer_outline.trim(),
      difficulty: draft.difficulty,
    });
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Deterministic templates.
//
// Built from the requirement's own words, so they cannot introduce a subject the
// posting never raised. They exist so that "no must-have ships uncovered" is a
// property of the code rather than a hope about the model.
// ---------------------------------------------------------------------------

/** The distinctive words of a requirement, for slotting into a template. */
function subjectOf(requirement: Requirement): string {
  const cleaned = requirement.text
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\b\d+\+?\s*years?\s*(?:of)?\s*/i, '')
    .replace(/\b(?:experience|strong|solid|proven|with|in|of|the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? requirement.text.trim() : cleaned;
}

const TEMPLATES: Record<QuestionCategory, (subject: string) => { prompt: string; outline: string }> = {
  technical: (subject) => ({
    prompt: `Walk me through something you built using ${subject}. What did you get wrong first, and how did you find out?`,
    outline: `Cover: the problem and why ${subject} suited it; one decision that turned out badly; how it surfaced; what you changed; what you would do differently now.`,
  }),
  behavioural: (subject) => ({
    prompt: `Tell me about a time ${subject} mattered on a project. What did you personally do, and what was the outcome?`,
    outline: `STAR: the situation, your specific task, the actions that were yours rather than the team's, the measurable result, and what changed in how you work afterwards.`,
  }),
  'system-design': (subject) => ({
    prompt: `Design a system where ${subject} is the binding constraint. Where does your first design break under load?`,
    outline: `Move through: clarifying requirements, the constraint, a first design, the failure mode at scale, and the trade-off you take. Name what you would measure before deciding.`,
  }),
  'company-fit': (subject) => ({
    prompt: `This role puts weight on ${subject}. What draws you to that, and what would you want to ask us about it?`,
    outline: `Draw on: what you have read about the company, why this element of the role fits what you want next, and a genuine question that shows you have thought about the work.`,
  }),
};

export function templatesFor(
  requirements: Requirement[],
  category: QuestionCategory,
): z.infer<typeof DraftQuestion>[] {
  return requirements.map((requirement) => {
    const { prompt, outline } = TEMPLATES[category](subjectOf(requirement));
    return {
      prompt,
      answer_outline: outline,
      requirement_ids: [requirement.id],
      difficulty: requirement.priority === 'must' ? 2 : 1,
    };
  });
}
