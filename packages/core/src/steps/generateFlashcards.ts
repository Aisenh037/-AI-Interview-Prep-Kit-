/**
 * Flashcards.
 *
 * Deliberately derived from requirements rather than from questions alone: a
 * flashcard should test recall of something the role actually demands, and
 * anchoring each card to a requirement id is what lets practice coverage be
 * reported per requirement later.
 *
 * The deterministic path builds cards from the questions already in the kit, so
 * even a total model outage still leaves something to practise against.
 */
import { z } from 'zod';
import type { Flashcard, Question, Requirement } from '@kit/shared';
import type { LlmRouter } from '../llm/router.js';
import { instructionHierarchy } from '../prompts/untrusted.js';

const DraftCard = z.object({
  front: z.string().min(3).max(300),
  back: z.string().min(3).max(800),
  requirement_ids: z.array(z.string()),
});

const CardBatch = z.object({ flashcards: z.array(DraftCard) });
type CardBatch = z.infer<typeof CardBatch>;

export interface GenerateFlashcardsInput {
  requirements: Requirement[];
  questions: Question[];
  roleTitle: string;
  nonce: string;
  router: LlmRouter;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateFlashcardsResult {
  flashcards: Flashcard[];
  warnings: string[];
}

const SYSTEM = (nonce: string): string =>
  [
    instructionHierarchy(nonce),
    '',
    'You write flashcards for someone revising before an interview.',
    '',
    'Rules:',
    '- front is a single prompt that can be answered from memory in under a minute.',
    '- back is the answer, compressed. Facts and structure, not prose.',
    '- Each card names the requirement ids it revises.',
    '- Cover the must-have requirements first.',
    '- Do not write a card about something the requirements never mention.',
  ].join('\n');

export async function generateFlashcards(
  input: GenerateFlashcardsInput,
): Promise<GenerateFlashcardsResult> {
  const warnings: string[] = [];

  if (input.requirements.length === 0 && input.questions.length === 0) {
    return { flashcards: [], warnings: ['NO_FLASHCARD_MATERIAL'] };
  }

  const user = [
    `Role: ${input.roleTitle || 'unspecified'}`,
    '',
    'Requirements:',
    ...input.requirements.map((r) => `- ${r.id} [${r.priority}] ${r.text}`),
    '',
    `Write one card per requirement, ${input.requirements.length + 2} cards at most.`,
  ].join('\n');

  const result = await input.router.callStructured<CardBatch>({
    callClass: 'flashcards',
    schemaName: 'flashcards',
    schema: CardBatch,
    system: SYSTEM(input.nonce),
    user,
    maxOutputTokens: 3000,
    fallback: () => ({ flashcards: derivedCards(input.requirements, input.questions) }),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  if (result.origin === 'fallback') warnings.push('FLASHCARDS_DERIVED');

  const known = new Set(input.requirements.map((r) => r.id));
  const flashcards: Flashcard[] = [];
  const seen = new Set<string>();

  for (const draft of result.value.flashcards) {
    const front = draft.front.trim();
    const back = draft.back.trim();
    const key = front.toLowerCase().replace(/\s+/g, ' ');
    if (front === '' || back === '' || seen.has(key)) continue;
    seen.add(key);
    flashcards.push({
      id: `f${flashcards.length + 1}`,
      front,
      back,
      requirement_ids: draft.requirement_ids.filter((id) => known.has(id)),
    });
  }

  return { flashcards, warnings };
}

/** Cards built from material already in the kit, when the model is unavailable. */
export function derivedCards(
  requirements: Requirement[],
  questions: Question[],
): z.infer<typeof DraftCard>[] {
  const cards: z.infer<typeof DraftCard>[] = [];

  for (const requirement of requirements) {
    const covering = questions.find((q) => q.requirement_ids.includes(requirement.id));
    cards.push({
      front: `What evidence can you give for: ${requirement.text}?`,
      back:
        covering !== undefined && covering.answer_outline !== ''
          ? covering.answer_outline.slice(0, 400)
          : 'Name a specific project, your part in it, and the outcome. One concrete example beats a general claim.',
      requirement_ids: [requirement.id],
    });
  }

  if (cards.length === 0) {
    for (const question of questions.slice(0, 5)) {
      cards.push({
        front: question.prompt,
        back: question.answer_outline || 'Prepare a concrete example.',
        requirement_ids: question.requirement_ids,
      });
    }
  }
  return cards;
}
