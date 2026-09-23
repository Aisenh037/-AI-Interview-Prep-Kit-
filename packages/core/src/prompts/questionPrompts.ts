/**
 * One prompt per question category.
 *
 * The brief is explicit that these must not share instructions: "a requirement
 * like five years of React leads to technical questions while mentoring junior
 * engineers leads to behavioural ones; the two should not come from the same
 * call with the same instructions." Separate builders, separate calls, and
 * separate answer-outline rubrics are the visible evidence of that.
 *
 * Each builder also receives the interview context. A company that publishes a
 * take-home followed by a system design round should produce a different kit
 * from one that publishes nothing, and the difference has to be legible in the
 * prompt rather than merely asserted in a README.
 */
import type { QuestionCategory, Requirement } from '@kit/shared';
import { instructionHierarchy } from './untrusted.js';

export interface InterviewContext {
  /** Whether a hiring-process page was actually found. */
  found: boolean;
  confidence: 'confident' | 'weak' | 'none';
  /** Stage vocabulary read from the page, e.g. ["take-home", "system design"]. */
  stages: string[];
  signals: { systemDesign: boolean; takeHome: boolean; pairing: boolean; values: boolean };
  /** Company values, when a values page was found. */
  values: string[];
  companyName: string;
  /** What public discussion turned up, if anything. */
  discussion: string[];
}

export function emptyInterviewContext(companyName = 'this company'): InterviewContext {
  return {
    found: false,
    confidence: 'none',
    stages: [],
    signals: { systemDesign: false, takeHome: false, pairing: false, values: false },
    values: [],
    companyName,
    discussion: [],
  };
}

/** Shared rules. Kept short; the per-category rubric does the real work. */
function base(nonce: string, category: QuestionCategory): string {
  return [
    instructionHierarchy(nonce),
    '',
    `You write ${category} interview questions.`,
    '',
    'Rules for every question:',
    '- Ground each question in the requirements you are given. Do not ask about things the role never mentioned.',
    '- List the ids of the requirements each question actually probes, in requirement_ids. Do not attach an id to a question that does not test it.',
    '- prompt is what the interviewer says out loud. One question, not three stacked together.',
    '- answer_outline is for the CANDIDATE preparing: what a strong answer contains. It is notes, not a script, and never a model answer to recite.',
    '- difficulty is 1, 2 or 3, where 1 is a warm-up and 3 would stretch a strong candidate.',
  ].join('\n');
}

/** The part of the prompt that changes because of what the research found. */
function contextBlock(context: InterviewContext): string {
  if (!context.found) {
    return [
      '',
      `Nothing is published about how ${context.companyName} interviews, and no public discussion of it was found.`,
      'Write questions that would be reasonable for this role at any company. Do not invent a process, and do not refer to stages you have no evidence for.',
    ].join('\n');
  }
  const lines = [
    '',
    `${context.companyName} publishes its interview process. Stages mentioned: ${context.stages.join(', ')}.`,
  ];
  if (context.signals.takeHome) {
    lines.push('There is a TAKE-HOME exercise, so favour questions about design decisions a candidate must defend in writing, and about trade-offs they would document.');
  }
  if (context.signals.systemDesign) {
    lines.push('There is a SYSTEM DESIGN round, so assume architecture will be probed in depth.');
  }
  if (context.signals.pairing) {
    lines.push('There is LIVE CODING or pairing, so favour questions a candidate must think aloud through.');
  }
  if (context.values.length > 0) {
    lines.push(`Their stated values are: ${context.values.join('; ')}.`);
  }
  if (context.discussion.length > 0) {
    lines.push(`Publicly reported experiences mention: ${context.discussion.slice(0, 5).join('; ')}.`);
  }
  return lines.join('\n');
}

function requirementBlock(requirements: Requirement[]): string {
  return requirements
    .map((r) => `- ${r.id} [${r.priority}] ${r.text}`)
    .join('\n');
}

export interface QuestionPromptInput {
  nonce: string;
  requirements: Requirement[];
  context: InterviewContext;
  roleTitle: string;
  seniority: string;
  perRequirement: number;
  /** Questions already in the kit, so a regeneration complements rather than repeats. */
  existing?: string[];
}

type Builder = (input: QuestionPromptInput) => { system: string; user: string };

const technical: Builder = (input) => ({
  system: [
    base(input.nonce, 'technical'),
    '',
    'Technical questions specifically:',
    '- Ask about work the candidate has actually done, not trivia with a single right answer. "How would you tune this" beats "what does this keyword mean".',
    '- Prefer questions that surface a trade-off the candidate had to make and got wrong at first.',
    '- The answer outline should name the concepts a strong answer touches, and one common wrong turn.',
    contextBlock(input.context),
  ].join('\n'),
  user: userTurn(input, 'technical'),
});

const behavioural: Builder = (input) => ({
  system: [
    base(input.nonce, 'behavioural'),
    '',
    'Behavioural questions specifically:',
    '- Ask for a specific past episode, not a policy. "Tell me about a time" beats "how do you feel about".',
    '- Target collaboration, disagreement, mentoring, ownership and what they would do differently.',
    '- The answer outline should be STAR-shaped: the situation, the task, what they personally did, the result, and what changed afterwards.',
    '- Never ask a technical question here. If a requirement is purely technical, find the human side of it or leave it alone.',
    contextBlock(input.context),
  ].join('\n'),
  user: userTurn(input, 'behavioural'),
});

const systemDesign: Builder = (input) => ({
  system: [
    base(input.nonce, 'system-design'),
    '',
    'System design questions specifically:',
    '- Pose an open design problem in the role’s own domain, with a constraint that forces a choice.',
    '- The answer outline should move through requirements, constraints, a first design, where it breaks under load, and the trade-off taken.',
    '- Name the failure mode a strong candidate raises unprompted.',
    contextBlock(input.context),
  ].join('\n'),
  user: userTurn(input, 'system-design'),
});

const companyFit: Builder = (input) => ({
  system: [
    base(input.nonce, 'company-fit'),
    '',
    'Company-fit questions specifically:',
    `- Ask what would show the candidate understands ${input.context.companyName} and why they want to work there.`,
    '- Ground every question in something the research actually found. If little was found, ask questions the candidate can answer from the job description alone, and keep them few.',
    '- The answer outline should say what evidence a good answer draws on, not what opinion to hold.',
    '- Never fabricate a detail about the company.',
    contextBlock(input.context),
  ].join('\n'),
  user: userTurn(input, 'company-fit'),
});

function userTurn(input: QuestionPromptInput, category: QuestionCategory): string {
  const parts = [
    `Role: ${input.roleTitle || 'unspecified'}${input.seniority ? ` (${input.seniority})` : ''}`,
    '',
    'Requirements to cover:',
    requirementBlock(input.requirements),
    '',
    `Write ${input.perRequirement} ${category} question(s) for EACH requirement above.`,
  ];
  if (input.existing !== undefined && input.existing.length > 0) {
    parts.push(
      '',
      'These questions already exist and must NOT be repeated or paraphrased:',
      ...input.existing.map((q) => `- ${q}`),
    );
  }
  return parts.join('\n');
}

export const QUESTION_PROMPTS: Record<QuestionCategory, Builder> = {
  technical,
  behavioural,
  'system-design': systemDesign,
  'company-fit': companyFit,
};

/**
 * A deliberately narrow prompt for the second pass.
 *
 * Pass-one misses are attention failures rather than capability failures — the
 * model was juggling eight requirements and skipped one. Asking about a single
 * requirement in isolation closes almost all of them, which is why a third
 * model pass would buy so little.
 */
export function gapFillPrompt(
  nonce: string,
  requirement: Requirement,
  category: QuestionCategory,
  context: InterviewContext,
): { system: string; user: string } {
  return {
    system: [
      base(nonce, category),
      '',
      'You are filling a single gap. One requirement, nothing else.',
      contextBlock(context),
    ].join('\n'),
    user: [
      `Write 2 ${category} questions that specifically probe this one requirement, and nothing else:`,
      '',
      `${requirement.id} [${requirement.priority}] ${requirement.text}`,
      '',
      `Set requirement_ids to ["${requirement.id}"] on both.`,
    ].join('\n'),
  };
}
