/**
 * Committing a regeneration.
 *
 * The decision of what may be touched lives in `planMerge`, which is pure and
 * exhaustively tested. This module does the writing, and its only job is to do
 * it safely:
 *
 *   1. Re-read live state at COMMIT time. Not the snapshot the job started from
 *      — an edit that landed while the model was thinking has to be visible
 *      here, or a run that never saw it would overwrite it.
 *   2. Guard every write on the version it was planned against. If the user
 *      edited between planning and committing, the guarded write matches
 *      nothing and we SKIP that item. Skipping is correct; retrying would
 *      clobber exactly the edit the guard just caught.
 *   3. Refuse to apply a superseded run. If a newer regeneration of the same
 *      section has started, this one is discarded whole. A half-applied stale
 *      run is worse than no run.
 */
import { planMerge, type MergeCandidate } from '@kit/shared';
import type { Question, QuestionCategory } from '@kit/shared';
import { Job, KitItem, KitModel } from '../../db/models.js';
import { contentHashOf, nextRankAfter, toMergeable } from '../kits/kits.service.js';
import { buildRouter } from './jobRunner.js';
import {
  emptyInterviewContext,
  generateQuestions,
  generateCompanyBrief,
  planCategories,
  allocateSchedule,
} from '@kit/core';

export interface RegenerationSummary {
  kept: number;
  replaced: number;
  added: number;
  retired: number;
  skippedDueToRace: number;
}

export async function regenerateSection(
  jobId: string,
  kitId: string,
  sectionKey: string,
): Promise<RegenerationSummary> {
  const kit = await KitModel.findById(kitId);
  if (kit === null) throw new Error('kit disappeared');

  const summary: RegenerationSummary = {
    kept: 0,
    replaced: 0,
    added: 0,
    retired: 0,
    skippedDueToRace: 0,
  };

  if (sectionKey === 'schedule') {
    await regenerateSchedule(kitId);
  } else if (sectionKey === 'brief') {
    await regenerateBrief(kitId);
  } else if (sectionKey.startsWith('questions:')) {
    Object.assign(summary, await regenerateQuestionCategory(kitId, sectionKey));
  }

  await KitModel.updateOne(
    { _id: kitId },
    {
      $set: {
        [`sections.${sectionKey}.activeRunId`]: null,
        [`sections.${sectionKey}.lastGeneratedAt`]: new Date(),
        [`sections.${sectionKey}.lastRunSummary`]: summary,
      },
      $inc: { version: 1 },
    },
  );

  await Job.updateOne(
    { _id: jobId },
    { $set: { status: 'succeeded', progress: 100, finishedAt: new Date() }, $unset: { active: '' } },
  );

  return summary;
}

async function regenerateQuestionCategory(
  kitId: string,
  sectionKey: string,
): Promise<RegenerationSummary> {
  const category = sectionKey.split(':')[1] as QuestionCategory;
  const kit = await KitModel.findById(kitId);
  if (kit === null) throw new Error('kit disappeared');

  const stored = kit.kit as import('@kit/shared').Kit | null;
  const requirements = stored?.role.requirements ?? [];

  // Snapshot only to build the prompt. The DECISION is made from live state.
  const snapshot = await KitItem.find({ kitId, listKey: sectionKey });
  const protectedTexts = snapshot
    .filter((item) => item.status === 'active')
    .map(toMergeable)
    .filter((item) => item.pinned || item.createdBy === 'user' || item.lastEditedBy === 'user')
    .map((item) => item.matchText);

  const context = {
    ...emptyInterviewContext(stored?.source.company ?? 'this company'),
    ...(kit.research as Record<string, unknown> | null)?.['interviewContext'] as object,
  };

  const plan = planCategories(requirements, context as never, stored?.role.seniority ?? '');
  const categoryPlan = plan.plans.filter((p) => p.category === category);

  const generated = await generateQuestions({
    plan: { plans: categoryPlan.length > 0 ? categoryPlan : plan.plans.slice(0, 1), rationale: [] },
    requirements,
    context: context as never,
    roleTitle: stored?.role.title ?? '',
    seniority: stored?.role.seniority ?? '',
    nonce: `regen-${kitId}`,
    router: buildRouter(),
  });

  const candidates: MergeCandidate[] = generated.questions
    .filter((q) => q.category === category)
    .filter((q) => !protectedTexts.some((text) => text.trim() === q.prompt.trim()))
    .map((q) => ({ matchText: q.prompt, payload: q }));

  // --- commit against LIVE state -------------------------------------------
  const live = await KitItem.find({ kitId, listKey: sectionKey });
  const mergePlan = planMerge(live.map(toMergeable), candidates);

  const summary: RegenerationSummary = {
    kept: mergePlan.summary.kept,
    replaced: 0,
    added: 0,
    retired: 0,
    skippedDueToRace: 0,
  };

  let lastRank = live
    .map((item) => item.rank)
    .sort()
    .at(-1) ?? null;

  for (const action of mergePlan.actions) {
    if (action.action === 'replace') {
      const question = action.candidate.payload as Question;
      const result = await KitItem.updateOne(
        // The guard: version AND still-unprotected. If an edit landed a
        // microsecond ago, neither holds and this matches nothing.
        {
          kitId,
          publicId: action.publicId,
          version: action.expectedVersion,
          status: 'active',
          lastEditedBy: 'ai',
          pinned: false,
        },
        {
          $set: {
            data: { ...question, id: action.publicId },
            lastEditedBy: 'ai',
            editedFields: [],
            contentHash: contentHashOf(question),
          },
          $inc: { version: 1 },
        },
      );
      if (result.matchedCount === 0) summary.skippedDueToRace += 1;
      else summary.replaced += 1;
    } else if (action.action === 'retire') {
      const result = await KitItem.updateOne(
        {
          kitId,
          publicId: action.publicId,
          version: action.expectedVersion,
          status: 'active',
          lastEditedBy: 'ai',
          pinned: false,
        },
        { $set: { status: 'superseded' }, $inc: { version: 1 } },
      );
      if (result.matchedCount === 0) summary.skippedDueToRace += 1;
      else summary.retired += 1;
    } else if (action.action === 'add') {
      const question = action.candidate.payload as Question;
      const updated = await KitModel.findOneAndUpdate(
        { _id: kitId },
        { $inc: { 'nextIds.q': 1 } },
        { returnDocument: 'after' },
      );
      // Ids come from a monotonic counter and are never reused, so an id the
      // schedule already references cannot be handed to a different question.
      const publicId = `q${(updated?.nextIds.q ?? 2) - 1}`;
      lastRank = nextRankAfter(lastRank);
      await KitItem.create({
        kitId,
        userId: kit.userId,
        publicId,
        type: 'question',
        listKey: sectionKey,
        rank: lastRank,
        status: 'active',
        version: 1,
        createdBy: 'ai',
        lastEditedBy: 'ai',
        editedFields: [],
        pinned: false,
        movedByUser: false,
        contentHash: contentHashOf(question),
        data: { ...question, id: publicId },
      });
      summary.added += 1;
    }
  }

  return summary;
}

/** Only fields the user has not claimed are replaced. */
async function regenerateBrief(kitId: string): Promise<void> {
  const kit = await KitModel.findById(kitId);
  if (kit === null) return;
  const stored = kit.kit as import('@kit/shared').Kit | null;
  if (stored === null) return;

  const result = await generateCompanyBrief({
    companyName: stored.source.company,
    companyUrl: stored.source.company_url,
    // Regeneration reuses the research already done rather than re-crawling.
    pages: stored.company_brief.sources.map((url) => ({
      url,
      title: stored.source.company,
      metaDescription: '',
      siteName: '',
      headings: [],
      text: `${stored.company_brief.summary} ${stored.company_brief.what_they_do}`,
      links: [],
      jsonLd: [],
    })),
    discussion: [],
    attemptedCount: stored.source.pages_used.length,
    nonce: `regen-brief-${kitId}`,
    router: buildRouter(),
  });

  const owned = new Set(kit.edited.brief);
  const next = { ...stored.company_brief };
  if (!owned.has('summary')) next.summary = result.brief.summary;
  if (!owned.has('what_they_do')) next.what_they_do = result.brief.what_they_do;

  await KitModel.updateOne(
    { _id: kitId },
    { $set: { 'kit.company_brief': next }, $inc: { version: 1 } },
  );
}

/**
 * Re-plan the schedule from the questions that exist now.
 *
 * Pure arithmetic, so no model is involved even here, and days the user pinned
 * are carried over untouched.
 */
async function regenerateSchedule(kitId: string): Promise<void> {
  const kit = await KitModel.findById(kitId);
  if (kit === null) return;
  const stored = kit.kit as import('@kit/shared').Kit | null;
  if (stored === null) return;

  const items = await KitItem.find({ kitId, status: 'active', type: 'question' });
  const questions = items.map((item) => ({ ...(item.data as Question), id: item.publicId }));

  const result = allocateSchedule({
    questions,
    requirements: stored.role.requirements,
    days: kit.input.days,
  });

  const pinned = new Set(kit.pinnedDays);
  const merged = result.schedule.days.map((day) => {
    if (!pinned.has(day.day)) return day;
    const existing = stored.schedule.days.find((d) => d.day === day.day);
    return existing ?? day;
  });

  await KitModel.updateOne(
    { _id: kitId },
    {
      $set: { 'kit.schedule': { days_available: kit.input.days, days: merged } },
      $inc: { version: 1 },
    },
  );
}
