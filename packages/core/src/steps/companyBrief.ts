/**
 * The company brief.
 *
 * The honesty requirement bites hardest here. "A company you can find nothing
 * about should produce an honest brief rather than a fabricated one", and a
 * language model asked to describe a company it knows nothing about will produce
 * fluent, plausible, entirely invented prose.
 *
 * So the model is only ever asked about pages we actually retrieved, and when we
 * retrieved nothing the model is not asked at all — the brief is written by code,
 * says plainly what was tried and what failed, and leaves `sources` empty. An
 * empty sources array is itself the honest signal, and it is a field Appendix A
 * already defines.
 */
import { z } from 'zod';
import type { CompanyBrief } from '@kit/shared';
import type { LlmRouter } from '../llm/router.js';
import type { CleanPage } from '../crawl/extract.js';
import { instructionHierarchy, wrapUntrusted } from '../prompts/untrusted.js';

const BriefSchema = z.object({
  summary: z.string().max(1200),
  what_they_do: z.string().max(1200),
  /** Values are captured here so the company-fit prompt can be grounded. */
  values: z.array(z.string().max(120)),
});

export interface CompanyBriefInput {
  companyName: string;
  companyUrl: string;
  pages: CleanPage[];
  /** Whatever public discussion turned up. May be empty. */
  discussion: string[];
  /** Everything the crawler tried, so failure can be described accurately. */
  attemptedCount: number;
  nonce: string;
  router: LlmRouter;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface CompanyBriefResult {
  brief: CompanyBrief;
  values: string[];
  warnings: string[];
}

const SYSTEM = (nonce: string, companyName: string): string =>
  [
    instructionHierarchy(nonce),
    '',
    `You write a short factual brief about ${companyName} for someone preparing to interview there.`,
    '',
    'Rules:',
    '- Use ONLY what the supplied pages say. If they do not say something, do not write it.',
    '- Never state a funding round, headcount, customer or claim that is not in the pages.',
    '- summary: two or three sentences on who they are and why that matters to a candidate.',
    '- what_they_do: what they actually sell or build, and to whom.',
    '- values: only values the pages explicitly state. If none are stated, return an empty list.',
    '- If the pages are thin, write a short brief. A short accurate brief is correct; a long invented one is not.',
  ].join('\n');

export async function generateCompanyBrief(
  input: CompanyBriefInput,
): Promise<CompanyBriefResult> {
  const warnings: string[] = [];
  const usable = input.pages.filter((page) => page.text.trim().length > 80);

  // Nothing was retrieved: say so, in code, without asking a model to improvise.
  if (usable.length === 0) {
    warnings.push('COMPANY_BRIEF_UNAVAILABLE');
    return {
      brief: honestEmptyBrief(input.companyName, input.companyUrl, input.attemptedCount),
      values: [],
      warnings,
    };
  }

  const documents = usable.slice(0, 4).map((page, index) => ({
    id: `page${index + 1}`,
    source: page.url,
    kind: 'company-page',
    text: `${page.title}\n${page.metaDescription}\n${page.text}`,
  }));

  const result = await input.router.callStructured<z.infer<typeof BriefSchema>>({
    callClass: 'brief',
    schemaName: 'company_brief',
    schema: BriefSchema,
    system: SYSTEM(input.nonce, input.companyName),
    user: wrapUntrusted(input.nonce, documents),
    maxOutputTokens: 2000,
    fallback: () => extractiveBrief(input.companyName, usable),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  if (result.origin === 'fallback') warnings.push('COMPANY_BRIEF_EXTRACTIVE');

  const summary = appendResearchNote(result.value.summary.trim(), input);

  return {
    brief: {
      summary,
      what_they_do: result.value.what_they_do.trim(),
      // Only pages we fetched ourselves may be cited. This is what stops an
      // injected link being laundered into the kit as a source.
      sources: usable.map((page) => page.url),
    },
    values: result.value.values.map((v) => v.trim()).filter((v) => v !== '').slice(0, 8),
    warnings,
  };
}

/**
 * The gaps go into `summary` deliberately.
 *
 * The FAQ asks for gaps "recorded honestly in the kit", and Appendix A has no
 * field for research notes. Putting the statement in a field the specification
 * already defines means the kit stays exactly conformant while still telling the
 * truth about what was not found.
 */
function appendResearchNote(summary: string, input: CompanyBriefInput): string {
  const notes: string[] = [];
  if (input.discussion.length === 0) {
    notes.push(
      `No public discussion of ${input.companyName}'s interview process was found, so the questions below are based on the job description and their own site.`,
    );
  }
  if (notes.length === 0) return summary;
  return [summary, ...notes].filter((s) => s !== '').join(' ');
}

export function honestEmptyBrief(
  companyName: string,
  companyUrl: string,
  attemptedCount: number,
): CompanyBrief {
  const attempted =
    attemptedCount > 0
      ? `We tried ${attemptedCount} address${attemptedCount === 1 ? '' : 'es'} on ${companyUrl} and could not retrieve a readable page.`
      : `We could not retrieve anything from ${companyUrl}.`;
  return {
    summary: `${attempted} This kit is therefore built from the job description alone, and nothing here should be taken as a description of ${companyName}.`,
    what_they_do: 'Unknown — no description of this company could be retrieved from public sources.',
    sources: [],
  };
}

/**
 * A brief assembled by quoting rather than writing, used when the model is
 * unavailable. It can only repeat sentences that are already on the page.
 */
export function extractiveBrief(
  companyName: string,
  pages: CleanPage[],
): z.infer<typeof BriefSchema> {
  const best = pages[0]!;
  const sentences = best.text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

  const summary =
    best.metaDescription !== ''
      ? best.metaDescription
      : sentences.slice(0, 2).join(' ').slice(0, 400);

  const doing =
    sentences.find((s) => /\bwe (?:build|make|help|provide|sell|design)\b|\bour (?:platform|product|mission)\b/i.test(s)) ??
    sentences[0] ??
    '';

  return {
    summary: summary === '' ? `No usable description of ${companyName} was found on its site.` : summary,
    what_they_do: doing,
    values: [],
  };
}
