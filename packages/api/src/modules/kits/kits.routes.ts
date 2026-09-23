/**
 * Kit and item endpoints.
 *
 * Ownership is applied in the query itself — every lookup is scoped by
 * `{ _id, userId }` — rather than checked in an `if` afterwards, so a new
 * endpoint cannot forget it. Another user's kit reports 404 rather than 403,
 * because a 403 confirms the id exists.
 */
import { Router } from 'express';
import { z } from 'zod';
import { describeBlastRadius } from '@kit/shared';
import type { Flashcard, Question, QuestionCategory } from '@kit/shared';
import { Job, KitItem, KitModel } from '../../db/models.js';
import { ApiError, asyncRoute, param, requireAuth, validate } from '../../middleware/index.js';
import {
  contentHashOf,
  dedupeKeyFor,
  listKeyFor,
  nextRankAfter,
  projectKit,
  rankBetween,
  toMergeable,
} from './kits.service.js';
import { enqueue } from '../jobs/jobRunner.js';

export const kitsRouter = Router();
kitsRouter.use(requireAuth);

const createSchema = z.object({
  jd: z.string().min(1, 'Paste the job description.').max(60_000),
  companyUrl: z.url('Enter the company website address, including https://'),
  days: z.coerce.number().int().min(1, 'At least one day.').max(365),
  force: z.boolean().optional(),
});

/** Find a kit the signed-in user owns, or report it missing. */
async function ownedKit(kitId: string, userId: string) {
  const kit = await KitModel.findOne({ _id: kitId, userId }).catch(() => null);
  if (kit === null) throw ApiError.notFound('No such kit.');
  return kit;
}

// ---------------------------------------------------------------------------
// Creating and listing
// ---------------------------------------------------------------------------

kitsRouter.post(
  '/',
  validate(createSchema),
  asyncRoute(async (req, res) => {
    const { jd, companyUrl, days, force } = req.body as z.infer<typeof createSchema>;
    const userId = req.userId ?? '';
    const dedupeKey = dedupeKeyFor(userId, jd, companyUrl);

    // `days` is deliberately NOT part of the key. The research is identical;
    // only the schedule differs. So the same posting with a different runway
    // re-runs the (pure, instant) allocator rather than spending a second
    // generation on work we already did.
    const existing = force === true ? null : await KitModel.findOne({ userId, dedupeKey }).sort({ revision: -1 });

    if (existing !== null) {
      if (existing.input.days !== days && existing.status === 'ready') {
        await KitModel.updateOne({ _id: existing._id }, { $set: { 'input.days': days } });
        const job = await Job.create({
          kitId: existing._id,
          userId,
          kind: 'regenerate',
          sectionKey: 'schedule',
          status: 'queued',
          active: true,
        });
        enqueue(String(job._id));
        res.status(200).json({
          data: {
            kitId: String(existing._id),
            jobId: String(job._id),
            duplicate: true,
            rescheduled: true,
          },
        });
        return;
      }

      const activeJob = await Job.findOne({ kitId: existing._id, active: true });
      res.status(200).json({
        data: {
          kitId: String(existing._id),
          jobId: activeJob === null ? null : String(activeJob._id),
          duplicate: true,
          rescheduled: false,
          status: existing.status,
        },
      });
      return;
    }

    const revision = force === true ? await nextRevision(userId, dedupeKey) : 0;

    let kit;
    try {
      kit = await KitModel.create({
        userId,
        dedupeKey,
        revision,
        input: { jd, companyUrl, days },
        status: 'queued',
        title: 'Preparing…',
      });
    } catch (error) {
      // Two simultaneous submissions of the same posting: the unique index
      // settles it, and the loser reads back the winner's kit.
      if ((error as { code?: number }).code === 11000) {
        const winner = await KitModel.findOne({ userId, dedupeKey, revision });
        if (winner !== null) {
          res.status(200).json({ data: { kitId: String(winner._id), duplicate: true } });
          return;
        }
      }
      throw error;
    }

    const job = await Job.create({ kitId: kit._id, userId, kind: 'generate', status: 'queued', active: true });
    enqueue(String(job._id));

    res.status(202).json({
      data: { kitId: String(kit._id), jobId: String(job._id), duplicate: false },
    });
  }),
);

async function nextRevision(userId: string, dedupeKey: string): Promise<number> {
  const latest = await KitModel.findOne({ userId, dedupeKey }).sort({ revision: -1 }).lean();
  return (latest?.revision ?? -1) + 1;
}

kitsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const kits = await KitModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(50).lean();
    const activeJobs = await Job.find({ userId: req.userId, active: true }).lean();
    const jobByKit = new Map(activeJobs.map((j) => [String(j.kitId), j]));

    res.json({
      data: kits.map((kit) => ({
        id: String(kit._id),
        title: kit.title,
        status: kit.status,
        companyUrl: kit.input.companyUrl,
        days: kit.input.days,
        createdAt: kit.createdAt,
        warnings: kit.warnings,
        job: (() => {
          const job = jobByKit.get(String(kit._id));
          return job === undefined ? null : { id: String(job._id), progress: job.progress };
        })(),
      })),
    });
  }),
);

kitsRouter.get(
  '/:kitId',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const items = await KitItem.find({ kitId: kit._id }).lean();
    const job = await Job.findOne({ kitId: kit._id }).sort({ createdAt: -1 }).lean();

    res.json({
      data: {
        id: String(kit._id),
        title: kit.title,
        status: kit.status,
        input: kit.input,
        // The Appendix A projection, recomputed from live items.
        kit: kit.kit === null ? null : projectKit(kit, items as never),
        // Provenance travels alongside, never inside the kit.
        items: items
          .filter((item) => item.status !== 'superseded')
          .map((item) => ({
            id: String(item._id),
            publicId: item.publicId,
            type: item.type,
            listKey: item.listKey,
            rank: item.rank,
            status: item.status,
            version: item.version,
            createdBy: item.createdBy,
            lastEditedBy: item.lastEditedBy,
            editedFields: item.editedFields,
            pinned: item.pinned,
            movedByUser: item.movedByUser,
            introducedByRunId: item.introducedByRunId,
            data: item.data,
          })),
        research: kit.research,
        warnings: kit.warnings,
        edited: kit.edited,
        pinnedDays: kit.pinnedDays,
        sections: kit.sections,
        job:
          job === null
            ? null
            : {
                id: String(job._id),
                status: job.status,
                progress: job.progress,
                steps: job.steps,
                events: job.events,
                error: job.error,
                sectionKey: job.sectionKey,
              },
      },
    });
  }),
);

kitsRouter.delete(
  '/:kitId',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    await KitItem.deleteMany({ kitId: kit._id });
    await Job.deleteMany({ kitId: kit._id });
    await KitModel.deleteOne({ _id: kit._id });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Items — the builder
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  patch: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().nonnegative(),
});

kitsRouter.patch(
  '/:kitId/items/:publicId',
  validate(patchSchema),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const publicId = param(req, 'publicId');
    const { patch, expectedVersion } = req.body as z.infer<typeof patchSchema>;

    const item = await KitItem.findOne({ kitId: kit._id, publicId });
    if (item === null) throw ApiError.notFound('No such item.');

    if (item.version !== expectedVersion) {
      // The other tab, or a regeneration, got there first. The client shows a
      // conflict banner rather than silently discarding what was typed.
      throw ApiError.conflict('CONFLICT_STALE_VERSION', 'Someone else changed this first.', {
        current: { version: item.version, data: item.data },
      });
    }

    const nextData = { ...(item.data as Record<string, unknown>), ...patch };

    // A no-op edit must not claim ownership of the field: opening an editor and
    // typing nothing would otherwise make the item permanently unregenerable.
    const changed = contentHashOf(nextData) !== contentHashOf(item.data);
    const editedFields = changed
      ? [...new Set([...item.editedFields, ...Object.keys(patch)])]
      : item.editedFields;

    await KitItem.updateOne(
      { _id: item._id, version: expectedVersion },
      {
        $set: {
          data: nextData,
          ...(changed ? { lastEditedBy: 'user', editedFields, contentHash: contentHashOf(nextData) } : {}),
        },
        $inc: { version: 1 },
      },
    );

    res.json({ data: { publicId, version: expectedVersion + 1, data: nextData, editedFields } });
  }),
);

const addSchema = z.object({
  type: z.enum(['question', 'flashcard']),
  category: z.enum(['technical', 'behavioural', 'system-design', 'company-fit']).optional(),
  data: z.record(z.string(), z.unknown()),
});

kitsRouter.post(
  '/:kitId/items',
  validate(addSchema),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { type, category, data } = req.body as z.infer<typeof addSchema>;
    const listKey = listKeyFor(type, category as QuestionCategory | undefined);

    const counterField = type === 'question' ? 'nextIds.q' : 'nextIds.f';
    const updated = await KitModel.findOneAndUpdate(
      { _id: kit._id },
      { $inc: { [counterField]: 1 } },
      { returnDocument: 'after' },
    );
    const counter = type === 'question' ? updated!.nextIds.q : updated!.nextIds.f;
    const publicId = `${type === 'question' ? 'q' : 'f'}${counter - 1}`;

    const last = await KitItem.find({ kitId: kit._id, listKey }).sort({ rank: -1 }).limit(1).lean();
    const rank = nextRankAfter(last[0]?.rank ?? null);

    const payload =
      type === 'question'
        ? ({
            id: publicId,
            requirement_ids: [],
            category: category ?? 'technical',
            prompt: '',
            answer_outline: '',
            difficulty: 2,
            ...data,
          } satisfies Partial<Question>)
        : ({ id: publicId, front: '', back: '', requirement_ids: [], ...data } satisfies Partial<Flashcard>);

    const item = await KitItem.create({
      kitId: kit._id,
      userId: kit.userId,
      publicId,
      type,
      listKey,
      rank,
      status: 'active',
      version: 1,
      // Authored by hand, so permanently protected from every regeneration.
      createdBy: 'user',
      lastEditedBy: 'user',
      editedFields: Object.keys(data),
      contentHash: contentHashOf(payload),
      data: payload,
    });

    res.status(201).json({
      data: { publicId, version: item.version, listKey, rank, data: payload, createdBy: 'user' },
    });
  }),
);

kitsRouter.delete(
  '/:kitId/items/:publicId',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    // Soft delete: undo is one query, and the tombstone stops the next
    // regeneration resurrecting it.
    const result = await KitItem.findOneAndUpdate(
      { kitId: kit._id, publicId: param(req, 'publicId') },
      { $set: { status: 'deleted' }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (result === null) throw ApiError.notFound('No such item.');
    res.json({ data: { publicId: result.publicId, status: 'deleted', version: result.version } });
  }),
);

kitsRouter.post(
  '/:kitId/items/:publicId/restore',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const result = await KitItem.findOneAndUpdate(
      { kitId: kit._id, publicId: param(req, 'publicId') },
      { $set: { status: 'active' }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (result === null) throw ApiError.notFound('No such item.');
    res.json({ data: { publicId: result.publicId, status: 'active', version: result.version } });
  }),
);

kitsRouter.put(
  '/:kitId/items/:publicId/pin',
  validate(z.object({ pinned: z.boolean() })),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { pinned } = req.body as { pinned: boolean };
    const result = await KitItem.findOneAndUpdate(
      { kitId: kit._id, publicId: param(req, 'publicId') },
      { $set: { pinned }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (result === null) throw ApiError.notFound('No such item.');
    res.json({ data: { publicId: result.publicId, pinned, version: result.version } });
  }),
);

const moveSchema = z.object({
  targetCategory: z.enum(['technical', 'behavioural', 'system-design', 'company-fit']).optional(),
  afterId: z.string().nullable().optional(),
  beforeId: z.string().nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
});

kitsRouter.post(
  '/:kitId/items/:publicId/move',
  validate(moveSchema),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const publicId = param(req, 'publicId');
    const { targetCategory, afterId, beforeId, expectedVersion } = req.body as z.infer<typeof moveSchema>;

    const item = await KitItem.findOne({ kitId: kit._id, publicId });
    if (item === null) throw ApiError.notFound('No such item.');
    if (item.version !== expectedVersion) {
      throw ApiError.conflict('CONFLICT_STALE_VERSION', 'This item changed while you were moving it.');
    }

    const listKey =
      targetCategory === undefined ? item.listKey : listKeyFor('question', targetCategory);

    const neighbour = async (id: string | null | undefined): Promise<string | null> => {
      if (id === null || id === undefined) return null;
      const found = await KitItem.findOne({ kitId: kit._id, publicId: id }).lean();
      return found?.rank ?? null;
    };
    // One field on one document, whatever the list length. A drag never
    // renumbers the array.
    const rank = rankBetween(await neighbour(afterId), await neighbour(beforeId));

    const data =
      targetCategory === undefined
        ? item.data
        : { ...(item.data as Question), category: targetCategory };

    await KitItem.updateOne(
      { _id: item._id, version: expectedVersion },
      {
        $set: {
          rank,
          listKey,
          data,
          // Moving something is an act of judgement, so it protects the item
          // from being replaced by a later regeneration.
          movedByUser: true,
        },
        $inc: { version: 1 },
      },
    );

    res.json({ data: { publicId, rank, listKey, version: expectedVersion + 1 } });
  }),
);

// ---------------------------------------------------------------------------
// Singleton sections and regeneration
// ---------------------------------------------------------------------------

kitsRouter.patch(
  '/:kitId/brief',
  validate(z.object({ patch: z.record(z.string(), z.string()) })),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { patch } = req.body as { patch: Record<string, string> };
    const fields = Object.keys(patch).filter((f) => f === 'summary' || f === 'what_they_do');

    await KitModel.updateOne(
      { _id: kit._id },
      {
        $set: Object.fromEntries(fields.map((f) => [`kit.company_brief.${f}`, patch[f]])),
        // Field-level ownership: regenerating the brief later replaces only the
        // fields the user has not claimed.
        $addToSet: { 'edited.brief': { $each: fields } },
        $inc: { version: 1 },
      },
    );
    res.json({ data: { edited: fields } });
  }),
);

kitsRouter.get(
  '/:kitId/regenerate/:sectionKey/preview',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const items = await KitItem.find({ kitId: kit._id, listKey: param(req, 'sectionKey') }).lean();
    // The user sees the blast radius BEFORE they commit.
    res.json({ data: { description: describeBlastRadius(items.map(toMergeable as never)) } });
  }),
);

kitsRouter.post(
  '/:kitId/regenerate',
  validate(z.object({ sectionKey: z.string().min(1) })),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { sectionKey } = req.body as { sectionKey: string };

    const busy = await Job.findOne({ kitId: kit._id, active: true });
    if (busy !== null) {
      throw ApiError.conflict('SECTION_BUSY', 'Something is already generating for this kit.', {
        jobId: String(busy._id),
      });
    }

    const job = await Job.create({
      kitId: kit._id,
      userId: kit.userId,
      kind: 'regenerate',
      sectionKey,
      status: 'queued',
      active: true,
    });
    await KitModel.updateOne(
      { _id: kit._id },
      { $set: { [`sections.${sectionKey}.activeRunId`]: String(job._id) } },
    );
    enqueue(String(job._id));

    res.status(202).json({ data: { jobId: String(job._id), sectionKey } });
  }),
);

kitsRouter.get(
  '/:kitId/job',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const job = await Job.findOne({ kitId: kit._id }).sort({ createdAt: -1 }).lean();
    if (job === null) {
      res.json({ data: null });
      return;
    }
    res.json({
      data: {
        id: String(job._id),
        status: job.status,
        progress: job.progress,
        steps: job.steps,
        events: job.events,
        error: job.error,
        sectionKey: job.sectionKey,
        kitStatus: kit.status,
      },
    });
  }),
);

/** The Appendix A structure, exactly, for download. */
kitsRouter.get(
  '/:kitId/export',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    if (kit.kit === null) throw ApiError.badRequest('NOT_READY', 'This kit is still generating.');
    const items = await KitItem.find({ kitId: kit._id }).lean();
    res
      .setHeader('content-disposition', `attachment; filename="kit-${String(kit._id)}.json"`)
      .json(projectKit(kit, items as never));
  }),
);
