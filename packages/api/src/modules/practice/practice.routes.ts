/**
 * Practice endpoints.
 *
 * The scheduling rules live in @kit/shared as pure functions; this is the thin
 * layer that reads and writes card state around them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { applyReview, orderSession, summarise, type CardState, type Confidence } from '@kit/shared';
import type { Flashcard, Kit } from '@kit/shared';
import { KitItem, KitModel, PracticeCard } from '../../db/models.js';
import { ApiError, asyncRoute, param, requireAuth, validate } from '../../middleware/index.js';

export const practiceRouter = Router();
practiceRouter.use(requireAuth);

async function ownedKit(kitId: string, userId: string) {
  const kit = await KitModel.findOne({ _id: kitId, userId }).catch(() => null);
  if (kit === null) throw ApiError.notFound('No such kit.');
  return kit;
}

/** Hours until the interview, from the runway the user gave us. */
function hoursRemaining(createdAt: Date, days: number): number {
  const elapsed = (Date.now() - createdAt.getTime()) / 3600_000;
  return Math.max(1, days * 24 - elapsed);
}

async function loadCards(kitId: string, userId: string): Promise<{
  cards: CardState[];
  byId: Map<string, Flashcard>;
}> {
  const items = await KitItem.find({ kitId, type: 'flashcard', status: 'active' }).lean();
  const kit = await KitModel.findById(kitId).lean();
  const stored = kit?.kit as Kit | null;
  const mustIds = new Set(
    (stored?.role.requirements ?? []).filter((r) => r.priority === 'must').map((r) => r.id),
  );

  const records = await PracticeCard.find({ userId, kitId }).lean();
  const recordById = new Map(records.map((r) => [r.cardId, r]));

  const byId = new Map<string, Flashcard>();
  const cards: CardState[] = items.map((item) => {
    const data = item.data as Flashcard;
    byId.set(item.publicId, { ...data, id: item.publicId });
    const record = recordById.get(item.publicId);
    return {
      cardId: item.publicId,
      seenCount: record?.seenCount ?? 0,
      lastConfidence: (record?.lastConfidence ?? null) as Confidence | null,
      streak: record?.streak ?? 0,
      lapses: record?.lapses ?? 0,
      ease: record?.ease ?? 2.3,
      dueAt: record?.dueAt?.getTime() ?? 0,
      coversMust: data.requirement_ids.some((id) => mustIds.has(id)),
    };
  });

  return { cards, byId };
}

practiceRouter.get(
  '/:kitId/session',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { cards, byId } = await loadCards(String(kit._id), req.userId ?? '');
    const limit = Number(req.query['limit'] ?? 20);

    const ordered = orderSession(cards, Date.now(), Number.isFinite(limit) ? limit : 20);
    res.json({
      data: {
        cards: ordered.map((entry) => {
          const card = byId.get(entry.cardId);
          return {
            cardId: entry.cardId,
            front: card?.front ?? '',
            back: card?.back ?? '',
            requirementIds: card?.requirement_ids ?? [],
            // Every card says why it is in front of you.
            reason: entry.reason,
          };
        }),
        stats: summarise(cards),
      },
    });
  }),
);

practiceRouter.post(
  '/:kitId/reviews',
  validate(z.object({ cardId: z.string().min(1), confidence: z.int().min(0).max(3) })),
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { cardId, confidence } = req.body as { cardId: string; confidence: Confidence };

    const existing = await PracticeCard.findOne({ userId: req.userId, kitId: kit._id, cardId });
    const state: CardState = {
      cardId,
      seenCount: existing?.seenCount ?? 0,
      lastConfidence: (existing?.lastConfidence ?? null) as Confidence | null,
      streak: existing?.streak ?? 0,
      lapses: existing?.lapses ?? 0,
      ease: existing?.ease ?? 2.3,
      dueAt: existing?.dueAt?.getTime() ?? Date.now(),
    };

    const outcome = applyReview(
      state,
      confidence,
      Date.now(),
      hoursRemaining(kit.createdAt as Date, kit.input.days),
    );

    await PracticeCard.updateOne(
      { userId: req.userId, kitId: kit._id, cardId },
      {
        $set: {
          lastConfidence: confidence,
          streak: outcome.streak,
          lapses: outcome.lapses,
          ease: outcome.ease,
          dueAt: new Date(outcome.dueAt),
          lastSeenAt: new Date(),
        },
        $inc: { seenCount: 1 },
      },
      { upsert: true },
    );

    res.json({
      data: { cardId, intervalHours: Math.round(outcome.intervalHours * 10) / 10, dueAt: outcome.dueAt },
    });
  }),
);

practiceRouter.get(
  '/:kitId/stats',
  asyncRoute(async (req, res) => {
    const kit = await ownedKit(param(req, 'kitId'), req.userId ?? '');
    const { cards } = await loadCards(String(kit._id), req.userId ?? '');
    const stored = kit.kit as Kit | null;

    // Two different meanings of coverage, reported separately on purpose.
    // Kit coverage asks whether a requirement has a question at all; practice
    // coverage asks whether the user can actually answer it yet.
    const byRequirement = (stored?.role.requirements ?? []).map((requirement) => {
      const related = cards.filter((card) =>
        (stored?.flashcards ?? [])
          .find((f) => f.id === card.cardId)
          ?.requirement_ids.includes(requirement.id),
      );
      const seen = related.filter((c) => c.seenCount > 0);
      const mean =
        seen.length === 0
          ? null
          : seen.reduce((sum, c) => sum + (c.lastConfidence ?? 0), 0) / seen.length;
      return {
        requirementId: requirement.id,
        text: requirement.text,
        priority: requirement.priority,
        cards: related.length,
        seen: seen.length,
        meanConfidence: mean,
      };
    });

    res.json({ data: { practice: summarise(cards), byRequirement } });
  }),
);
