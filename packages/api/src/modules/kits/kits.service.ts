/**
 * Turning stored items back into a kit, and back again.
 *
 * `projectKit` is the ONLY path from storage to an Appendix A structure. It
 * builds fresh objects rather than spreading stored ones, so an internal field
 * cannot leak into a graded artefact by accident, and it recomputes coverage and
 * day count from live data rather than trusting values written earlier — a user
 * who deletes a question must not leave the coverage object lying about it.
 */
import { createHash } from 'node:crypto';
import { generateKeyBetween } from 'fractional-indexing';
import {
  CATEGORY_ORDER,
  validateKitForExport,
  type Flashcard,
  type Kit,
  type Question,
  type QuestionCategory,
  type Requirement,
} from '@kit/shared';
import type { MergeableItem } from '@kit/shared';
import type { KitDoc, KitItemDoc } from '../../db/models.js';

export type ItemType = 'requirement' | 'question' | 'flashcard' | 'story';

export interface StoryData {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  requirement_ids: string[];
}

/** The list an item belongs to. Questions are split by category so that a
 *  regeneration of one category cannot disturb another's ordering. */
export function listKeyFor(type: ItemType, category?: QuestionCategory): string {
  if (type === 'question') return `questions:${category ?? 'technical'}`;
  return type === 'requirement' ? 'requirements' : type === 'flashcard' ? 'flashcards' : 'stories';
}

export function contentHashOf(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
}

/** Canonical dedupe key. Deliberately excludes `days`: see the create route. */
export function dedupeKeyFor(userId: string, jd: string, companyUrl: string): string {
  const normalisedJd = jd
    .normalize('NFKC')
    .replace(/[​-‏⁠-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  let canonicalUrl = companyUrl.trim().toLowerCase();
  try {
    const url = new URL(canonicalUrl);
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./, '');
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid']) {
      url.searchParams.delete(p);
    }
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    canonicalUrl = url.toString();
  } catch {
    // keep the raw string; an unparseable URL still dedupes against itself
  }

  return createHash('sha256')
    .update(`${userId}\u001f${canonicalUrl}\u001f${createHash('sha256').update(normalisedJd).digest('hex')}`)
    .digest('hex');
}

export function toMergeable(item: KitItemDoc): MergeableItem {
  const data = item.data as Record<string, unknown>;
  const matchText =
    typeof data['prompt'] === 'string'
      ? data['prompt']
      : typeof data['front'] === 'string'
        ? data['front']
        : typeof data['text'] === 'string'
          ? data['text']
          : typeof data['title'] === 'string'
            ? data['title']
            : '';
  return {
    publicId: item.publicId,
    version: item.version,
    status: item.status as MergeableItem['status'],
    rank: item.rank,
    createdBy: item.createdBy as MergeableItem['createdBy'],
    lastEditedBy: item.lastEditedBy as MergeableItem['lastEditedBy'],
    editedFields: item.editedFields,
    pinned: item.pinned,
    movedByUser: item.movedByUser,
    matchText,
  };
}

/** Sort by rank, then id, so ordering is total and stable. */
function byRank(a: KitItemDoc, b: KitItemDoc): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.publicId.localeCompare(b.publicId);
}

export function nextRankAfter(last: string | null): string {
  return generateKeyBetween(last, null);
}

export function rankBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/**
 * Build the Appendix A structure from stored state.
 *
 * Everything user-visible flows through here, including the export the batch
 * command writes, so there is one definition of what a kit is.
 */
export function projectKit(kitDoc: KitDoc, items: KitItemDoc[]): Kit {
  const live = items.filter((item) => item.status === 'active');
  const stored = (kitDoc.kit ?? {}) as Partial<Kit>;

  const requirements: Requirement[] = live
    .filter((item) => item.type === 'requirement')
    .sort(byRank)
    .map((item) => {
      const data = item.data as Requirement;
      return {
        id: item.publicId,
        text: data.text,
        kind: data.kind,
        priority: data.priority,
      };
    });
  const requirementIds = new Set(requirements.map((r) => r.id));

  const questions: Question[] = live
    .filter((item) => item.type === 'question')
    .sort((a, b) => {
      const left = (a.data as Question).category;
      const right = (b.data as Question).category;
      const byCategory = CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right);
      return byCategory !== 0 ? byCategory : byRank(a, b);
    })
    .map((item) => {
      const data = item.data as Question;
      return {
        id: item.publicId,
        // Dangling references are filtered rather than exported: a requirement
        // the user deleted must not leave a broken pointer behind.
        requirement_ids: data.requirement_ids.filter((id) => requirementIds.has(id)),
        category: data.category,
        prompt: data.prompt,
        answer_outline: data.answer_outline,
        difficulty: data.difficulty,
      };
    });
  const questionIds = new Set(questions.map((q) => q.id));

  const flashcards: Flashcard[] = live
    .filter((item) => item.type === 'flashcard')
    .sort(byRank)
    .map((item) => {
      const data = item.data as Flashcard;
      return {
        id: item.publicId,
        front: data.front,
        back: data.back,
        requirement_ids: data.requirement_ids.filter((id) => requirementIds.has(id)),
      };
    });

  const storedSchedule = stored.schedule ?? { days_available: 1, days: [] };
  const days = storedSchedule.days.map((day) => ({
    day: day.day,
    focus: day.focus,
    question_ids: day.question_ids.filter((id) => questionIds.has(id)),
    minutes: day.minutes,
  }));

  return {
    source: stored.source ?? {
      company: '',
      company_url: kitDoc.input.companyUrl,
      role: '',
      location: '',
      jd_chars: kitDoc.input.jd.length,
      researched_at: new Date(0).toISOString(),
      pages_used: [],
    },
    company_brief: stored.company_brief ?? { summary: '', what_they_do: '', sources: [] },
    role: {
      title: stored.role?.title ?? '',
      seniority: stored.role?.seniority ?? '',
      responsibilities: stored.role?.responsibilities ?? [],
      requirements,
    },
    questions,
    flashcards,
    schedule: {
      // Recomputed from what is actually there, never trusted from storage.
      days_available: days.length,
      days,
    },
    coverage: {
      uncovered_requirement_ids: requirements
        .filter((r) => !questions.some((q) => q.requirement_ids.includes(r.id)))
        .map((r) => r.id),
      passes: stored.coverage?.passes ?? 1,
    },
  };
}

/** Project and validate. Used wherever a kit leaves the system. */
export function projectAndValidate(
  kitDoc: KitDoc,
  items: KitItemDoc[],
): { ok: true; kit: Kit } | { ok: false; issues: { path: string; message: string }[] } {
  return validateKitForExport(projectKit(kitDoc, items));
}
