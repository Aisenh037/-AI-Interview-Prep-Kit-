/**
 * Deciding which question categories to generate, and how many of each.
 *
 * This is the fork in the road, and it is deterministic on purpose. The brief
 * wants a hiring page to visibly change the output — "a company that publishes a
 * take-home followed by a system design round should produce a different kit
 * from one that says nothing" — and a reviewer should be able to diff two runs
 * and SEE that happen rather than take it on trust. A prompt that "considers the
 * context" proves nothing; a plan object that differs does.
 */
import type { QuestionCategory, Requirement } from '@kit/shared';
import type { InterviewContext } from '../prompts/questionPrompts.js';

export interface CategoryPlan {
  category: QuestionCategory;
  requirements: Requirement[];
  perRequirement: number;
  /** Why this category is in the plan, recorded for the research log. */
  reason: string;
}

export interface GenerationPlan {
  plans: CategoryPlan[];
  /** A short, human-readable account of what the research changed. */
  rationale: string[];
}

/** Architecture vocabulary that justifies a system design question on its own. */
const ARCHITECTURE_CUES =
  /\b(?:architect\w*|scal\w*|distributed|microservices?|throughput|latency|high[- ]availability|resilien\w*|queue|streaming|sharding|caching|load balanc\w*|system design)\b/i;

const SENIOR_CUES = /\b(?:senior|staff|principal|lead|head|director|architect)\b/i;

/** Requirements are shared out by kind, not duplicated into every category. */
function routeByKind(requirements: Requirement[]): Record<QuestionCategory, Requirement[]> {
  const routed: Record<QuestionCategory, Requirement[]> = {
    technical: [],
    behavioural: [],
    'system-design': [],
    'company-fit': [],
  };

  for (const requirement of requirements) {
    switch (requirement.kind) {
      case 'technical':
        routed.technical.push(requirement);
        break;
      case 'behavioural':
        routed.behavioural.push(requirement);
        break;
      case 'domain':
        // Domain knowledge is probed both as subject matter and as motivation.
        routed.technical.push(requirement);
        routed['company-fit'].push(requirement);
        break;
    }
  }
  return routed;
}

export function planCategories(
  requirements: Requirement[],
  context: InterviewContext,
  seniority: string,
): GenerationPlan {
  const routed = routeByKind(requirements);
  const rationale: string[] = [];
  const plans: CategoryPlan[] = [];

  const isSenior = SENIOR_CUES.test(seniority);
  const hasArchitecture = requirements.some((r) => ARCHITECTURE_CUES.test(r.text));

  // --- technical ------------------------------------------------------------
  if (routed.technical.length > 0) {
    let perRequirement = 2;
    let reason = 'technical requirements were extracted';
    if (context.signals.takeHome) {
      perRequirement = 3;
      reason = 'the company publishes a take-home, so technical depth is weighted higher';
      rationale.push('Take-home found: technical questions increased and framed around decisions to defend in writing.');
    }
    plans.push({ category: 'technical', requirements: routed.technical, perRequirement, reason });
  }

  // --- behavioural ----------------------------------------------------------
  if (routed.behavioural.length > 0) {
    plans.push({
      category: 'behavioural',
      requirements: routed.behavioural,
      perRequirement: 2,
      reason: 'behavioural requirements were extracted',
    });
  }

  // --- system design --------------------------------------------------------
  // Forced on when the company says it runs one. Otherwise only when the role
  // itself justifies it, because inventing a design round is its own kind of
  // fabrication.
  const designRequirements =
    routed.technical.length > 0 ? routed.technical : requirements.slice(0, 3);
  if (context.signals.systemDesign) {
    plans.push({
      category: 'system-design',
      requirements: designRequirements,
      perRequirement: 2,
      reason: 'the company publishes a system design round',
    });
    rationale.push('System design round found: that category was added and weighted.');
  } else if (isSenior && hasArchitecture) {
    plans.push({
      category: 'system-design',
      requirements: designRequirements.filter((r) => ARCHITECTURE_CUES.test(r.text)),
      perRequirement: 1,
      reason: 'a senior role with architecture requirements, though the company publishes no design round',
    });
    rationale.push('No published design round, but the role is senior and mentions architecture: one design question added.');
  }

  // --- company fit ----------------------------------------------------------
  // Always present, but its weight depends on how much was actually found. A
  // company we know nothing about gets fewer questions, not invented ones.
  const fitPerRequirement = context.values.length > 0 ? 2 : 1;
  if (context.values.length > 0) {
    rationale.push('Values page found: company-fit questions increased and grounded in the stated values.');
  }
  plans.push({
    category: 'company-fit',
    requirements: routed['company-fit'].length > 0 ? routed['company-fit'] : requirements.slice(0, 2),
    perRequirement: fitPerRequirement,
    reason: context.found
      ? 'research found material about the company'
      : 'little was found about the company, so this section is deliberately small',
  });

  if (!context.found) {
    rationale.push('No hiring process published and no public discussion found: questions are role-based only, and no process was assumed.');
  }

  return { plans: plans.filter((p) => p.requirements.length > 0), rationale };
}
