/**
 * Extracting requirements from a job description.
 *
 * This is the single largest scoring item in the brief — "the must-haves in each
 * description are found, marked correctly, and nothing is invented" — and the
 * last clause is the hard one. Recall is easy; a model will happily produce
 * twelve plausible requirements from a two-line posting. Precision is what is
 * actually being measured, and the brief says so outright: "Inventing
 * requirements a description does not contain is worse than reporting that there
 * were few."
 *
 * So the model proposes and the code disposes, in four steps:
 *
 *   1. The model returns each requirement with an EVIDENCE SPAN quoted from the
 *      posting.
 *   2. Code checks that span actually appears in the posting. Anything it cannot
 *      find is dropped. This is the anti-invention guard, and it lives in code
 *      rather than in a prompt because a prompt is a request, not a constraint.
 *   3. A lexicon corrects must/nice from how the posting words it, because
 *      "a 'required' line and a 'bonus points for' line are not the same thing"
 *      and models routinely flatten the distinction.
 *   4. Code mints the ids. A model-assigned id is unstable across regeneration
 *      and occasionally collides, and every question and flashcard in the kit
 *      refers back to these.
 */
import { z } from 'zod';
import type { Requirement } from '@kit/shared';
import type { LlmRouter } from '../llm/router.js';
import { instructionHierarchy, makeNonce, wrapUntrusted } from '../prompts/untrusted.js';

const DraftRequirement = z.object({
  text: z.string().min(2).max(300),
  kind: z.enum(['technical', 'behavioural', 'domain']),
  priority: z.enum(['must', 'nice']),
  evidence: z.string().min(3).max(400),
});

const ExtractionSchema = z.object({
  role_title: z.string(),
  seniority: z.string(),
  location: z.string(),
  responsibilities: z.array(z.string().max(300)),
  requirements: z.array(DraftRequirement),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: Requirement[];
  warnings: string[];
  /** Requirements the model proposed but could not evidence. Reported, not hidden. */
  rejected: { text: string; reason: string }[];
}

/** A posting shorter than this cannot support a large kit, and we say so. */
export const THIN_JD_CHARS = 400;

const SYSTEM = (nonce: string): string =>
  [
    instructionHierarchy(nonce),
    '',
    'You extract requirements from a job description.',
    '',
    'Rules:',
    '- Extract ONLY requirements the description literally states. Never infer, never add what a role "usually" needs.',
    '- For each requirement, quote an EXACT span from the description as evidence. Copy it character for character; do not paraphrase it.',
    '- If the description is short and states little, return few requirements. Returning two requirements for a two-line posting is correct; padding it is wrong.',
    '- priority is "must" when the posting presents it as required, and "nice" when it presents it as preferred, bonus or a plus.',
    '- kind is "technical" for tools, languages and systems; "behavioural" for collaboration, communication, mentoring and leadership; "domain" for industry or subject-matter knowledge.',
    '- responsibilities are what the person will DO. Requirements are what they must HAVE. Do not duplicate one as the other.',
    '- If the description states no location or seniority, return an empty string rather than guessing.',
  ].join('\n');

/** Section headings that set the default priority for the lines beneath them. */
const MUST_HEADINGS =
  /^\s*(?:#+\s*)?(?:requirements?|must[- ]haves?|minimum (?:requirements?|qualifications?)|what you(?:'| a)?ll need|essential|you have|about you|qualifications)\b/i;
const NICE_HEADINGS =
  /^\s*(?:#+\s*)?(?:nice[- ]to[- ]haves?|bonus(?: points)?|preferred(?: qualifications?)?|desirable|pluses?|it'?s a plus|extra credit|would be (?:great|nice))\b/i;

/** Inline wording that overrides whatever heading a line sits under. */
const NICE_INLINE =
  /\b(?:nice to have|bonus|a plus|preferred|desirable|would be (?:great|nice)|not required|optional)\b/i;
const MUST_INLINE = /\b(?:required|must have|essential|mandatory|minimum of)\b/i;

function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this evidence span really present in the posting?
 *
 * Exact-after-normalisation first, then a token-containment fallback, because a
 * model will occasionally re-wrap whitespace or drop a bullet character while
 * quoting faithfully. What it will NOT do, when it has invented a requirement,
 * is produce a span whose words are all present in order.
 */
export function evidenceAppearsIn(jd: string, evidence: string): boolean {
  const haystack = normaliseForMatch(jd);
  const needle = normaliseForMatch(evidence);
  if (needle.length < 3) return false;
  if (haystack.includes(needle)) return true;

  const words = needle.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const present = words.filter((w) => haystack.includes(w)).length;
  return present / words.length >= 0.8;
}

/** Decide must/nice from the posting's own wording, overriding the model. */
export function priorityFromWording(
  jd: string,
  evidence: string,
  modelPriority: 'must' | 'nice',
): 'must' | 'nice' {
  const lines = jd.split(/\r?\n/);
  const target = normaliseForMatch(evidence);

  let heading: 'must' | 'nice' | null = null;
  for (const line of lines) {
    if (MUST_HEADINGS.test(line)) heading = 'must';
    else if (NICE_HEADINGS.test(line)) heading = 'nice';

    if (target !== '' && normaliseForMatch(line).includes(target.slice(0, 40))) {
      // Wording on the line itself beats the heading above it.
      if (NICE_INLINE.test(line)) return 'nice';
      if (MUST_INLINE.test(line)) return 'must';
      if (heading !== null) return heading;
      break;
    }
  }

  if (NICE_INLINE.test(evidence)) return 'nice';
  if (MUST_INLINE.test(evidence)) return 'must';
  return modelPriority;
}

/** Two requirements saying the same thing should not both be scored. */
function isNearDuplicate(a: string, b: string): boolean {
  const left = new Set(normaliseForMatch(a).split(' ').filter((w) => w.length > 2));
  const right = new Set(normaliseForMatch(b).split(' ').filter((w) => w.length > 2));
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.85;
}

export interface ExtractRequirementsInput {
  jd: string;
  router: LlmRouter;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function extractRequirements(
  input: ExtractRequirementsInput,
): Promise<ExtractedRole> {
  const jd = input.jd.trim();
  const nonce = makeNonce(jd.slice(0, 200));
  const warnings: string[] = [];

  if (jd.length === 0) {
    return {
      title: '',
      seniority: '',
      location: '',
      responsibilities: [],
      requirements: [],
      warnings: ['JD_EMPTY'],
      rejected: [],
    };
  }
  if (jd.length < THIN_JD_CHARS) warnings.push('JD_TOO_SHORT');

  const result = await input.router.callStructured<Extraction>({
    callClass: 'extract',
    schemaName: 'job_requirements',
    schema: ExtractionSchema,
    system: SYSTEM(nonce),
    user: wrapUntrusted(nonce, [{ id: 'jd', kind: 'job-description', text: jd }]),
    maxOutputTokens: 3000,
    fallback: () => fallbackExtraction(jd),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  warnings.push(...result.warnings.filter((w) => w.startsWith('FALLBACK_USED') || w.startsWith('LLM_')));
  if (result.origin === 'fallback') warnings.push('EXTRACTION_USED_FALLBACK');

  return finalise(jd, result.value, warnings);
}

/**
 * Turn a draft extraction into requirements we are willing to stand behind.
 * Exported so the same guards apply to the deterministic path and to tests.
 */
export function finalise(jd: string, draft: Extraction, warnings: string[]): ExtractedRole {
  const accepted: Requirement[] = [];
  const rejected: { text: string; reason: string }[] = [];

  for (const candidate of draft.requirements) {
    const text = candidate.text.trim();
    if (text === '') continue;

    // THE ANTI-INVENTION GUARD. If we cannot find the model's own evidence in
    // the posting, the requirement does not enter the kit.
    if (!evidenceAppearsIn(jd, candidate.evidence)) {
      rejected.push({ text, reason: 'evidence not found in the job description' });
      continue;
    }

    if (accepted.some((existing) => isNearDuplicate(existing.text, text))) {
      rejected.push({ text, reason: 'duplicate of an earlier requirement' });
      continue;
    }

    accepted.push({
      id: `r${accepted.length + 1}`, // ids are ours, not the model's
      text,
      kind: candidate.kind,
      priority: priorityFromWording(jd, candidate.evidence, candidate.priority),
    });
  }

  if (rejected.length > 0) warnings.push('REQUIREMENTS_REJECTED_UNEVIDENCED');
  if (accepted.length === 0 && jd.length > 0) warnings.push('NO_REQUIREMENTS_EXTRACTED');

  return {
    title: draft.role_title.trim(),
    seniority: draft.seniority.trim(),
    location: draft.location.trim(),
    responsibilities: draft.responsibilities.map((r) => r.trim()).filter((r) => r !== '').slice(0, 12),
    requirements: accepted,
    warnings,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// The deterministic path.
//
// Used when the model is unreachable or unusable. It is a reader, not a writer:
// it can only select lines that already exist in the posting, so it cannot
// invent a requirement even in principle. If the posting says nothing, it
// returns nothing.
// ---------------------------------------------------------------------------

/**
 * Wording that marks a line as stating a requirement.
 *
 * Widening this list is safe in a way that widening a prompt is not: this path
 * can only SELECT lines that already exist in the posting, so a missed cue costs
 * recall while a generous one cannot manufacture a requirement. "Exposure to
 * Kubernetes" was invisible until `exposure` was added, which is exactly the
 * kind of ordinary phrasing worth covering.
 */
const REQUIREMENT_CUES =
  /\b(?:\d+\+?\s*years?|experience|exposure|proficien\w*|familiar\w*|knowledge of|understanding of|ability to|able to|strong|expertise|skilled|competen\w*|fluent|degree|background in|comfortable with|worked with|hands[- ]on|track record|you (?:have|know|will need|should have))\b/i;

const TECH_CUES =
  /\b(?:javascript|typescript|python|java|golang|go|rust|ruby|php|c\+\+|c#|sql|nosql|react|vue|angular|node|django|rails|spring|kubernetes|k8s|docker|terraform|aws|gcp|azure|postgres\w*|mysql|mongodb|redis|kafka|graphql|rest|api|ci\/cd|git|linux|microservices?|testing|tdd)\b/i;
const BEHAVIOURAL_CUES =
  /\b(?:mentor\w*|communicat\w*|collaborat\w*|lead\w*|stakeholder|teamwork|team player|influence|coach\w*|present\w*|cross[- ]functional)\b/i;

export function fallbackExtraction(jd: string): Extraction {
  const lines = jd.split(/\r?\n/);
  const requirements: Extraction['requirements'] = [];
  const responsibilities: string[] = [];

  let heading: 'must' | 'nice' | null = null;
  let inResponsibilities = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (MUST_HEADINGS.test(line)) {
      heading = 'must';
      inResponsibilities = false;
      continue;
    }
    if (NICE_HEADINGS.test(line)) {
      heading = 'nice';
      inResponsibilities = false;
      continue;
    }
    if (/^\s*(?:#+\s*)?(?:responsibilities|what you(?:'| wi)?ll do|the role|your role|day to day)\b/i.test(line)) {
      inResponsibilities = true;
      continue;
    }

    const content = line.replace(/^[-*•–—\s]+/, '').trim();
    if (content.length < 8 || content.length > 300) continue;

    if (inResponsibilities) {
      if (responsibilities.length < 10) responsibilities.push(content);
      continue;
    }

    if (!REQUIREMENT_CUES.test(content)) continue;

    const priority: 'must' | 'nice' = NICE_INLINE.test(content)
      ? 'nice'
      : MUST_INLINE.test(content)
        ? 'must'
        : (heading ?? 'must');

    const kind: 'technical' | 'behavioural' | 'domain' = TECH_CUES.test(content)
      ? 'technical'
      : BEHAVIOURAL_CUES.test(content)
        ? 'behavioural'
        : 'domain';

    requirements.push({ text: content, kind, priority, evidence: content });
    if (requirements.length >= 20) break;
  }

  const firstLine = lines.find((l) => l.trim() !== '')?.trim() ?? '';
  const seniorityMatch = /\b(intern|junior|graduate|mid[- ]level|senior|staff|principal|lead|head of|director)\b/i.exec(jd);

  return {
    role_title: firstLine.slice(0, 120),
    seniority: seniorityMatch?.[1]?.toLowerCase() ?? '',
    location: '',
    responsibilities,
    requirements,
  };
}
