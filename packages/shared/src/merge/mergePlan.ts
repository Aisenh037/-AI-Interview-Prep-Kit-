/**
 * What a regeneration is allowed to touch.
 *
 * The brief calls this "the hardest state problem in the assessment", and the
 * requirement is precise: "Regenerating one section must not discard edits the
 * user has made elsewhere, and a question the user wrote or edited by hand must
 * survive a regeneration of its category."
 *
 * The rule, stated once:
 *
 *   ANYTHING A HUMAN TOUCHED IS PROTECTED BY DEFAULT.
 *   PINNING EXISTS TO PROTECT SOMETHING THEY HAVE NOT TOUCHED.
 *
 * That inversion is what makes the feature usable. Requiring a pin before
 * regenerating would mean losing work the first time someone forgets, and they
 * will forget, because the moment you want to regenerate is the moment you are
 * thinking about the new questions rather than the old ones.
 *
 * This module is PURE: it decides, and the caller writes. That separation is
 * deliberate — the decision is the part worth testing exhaustively, and it
 * should not need a database to test.
 */

export type ItemOrigin = 'ai' | 'user';
export type ItemStatus = 'active' | 'deleted' | 'superseded';

export interface MergeableItem {
  publicId: string;
  version: number;
  status: ItemStatus;
  rank: string;
  createdBy: ItemOrigin;
  lastEditedBy: ItemOrigin;
  editedFields: string[];
  pinned: boolean;
  movedByUser: boolean;
  /** Text used for matching a regenerated candidate to the slot it replaces. */
  matchText: string;
}

export interface MergeCandidate {
  /** Text used for matching, usually the question prompt. */
  matchText: string;
  /** Opaque payload written into the item if this candidate is used. */
  payload: unknown;
}

export type MergeAction =
  | { action: 'keep'; publicId: string; reason: ProtectionReason }
  | { action: 'replace'; publicId: string; expectedVersion: number; candidate: MergeCandidate }
  | { action: 'add'; candidate: MergeCandidate }
  | { action: 'retire'; publicId: string; expectedVersion: number };

export type ProtectionReason = 'pinned' | 'authored' | 'edited' | 'moved' | 'deleted';

export interface MergePlan {
  actions: MergeAction[];
  summary: { kept: number; replaced: number; added: number; retired: number };
  /** Protected items, so the prompt can be told not to repeat them. */
  protectedTexts: string[];
}

/** Why an item is off limits, or null if a regeneration may replace it. */
export function protectionReason(item: MergeableItem): ProtectionReason | null {
  if (item.status === 'deleted') return 'deleted'; // a tombstone stays dead
  if (item.pinned) return 'pinned';
  if (item.createdBy === 'user') return 'authored';
  if (item.lastEditedBy === 'user' || item.editedFields.length > 0) return 'edited';
  if (item.movedByUser) return 'moved';
  return null;
}

export function isProtected(item: MergeableItem): boolean {
  return protectionReason(item) !== null;
}

/** Normalised bigrams, for measuring how alike two questions are. */
function bigrams(text: string): Set<string> {
  const normalised = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  for (let i = 0; i < normalised.length - 1; i += 1) grams.add(normalised.slice(i, i + 2));
  return grams;
}

/** Dice coefficient: 1 is identical, 0 shares nothing. */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

const MATCH_THRESHOLD = 0.6;

/**
 * Decide what a regeneration does to a list.
 *
 * Candidates are matched to the replaceable slots they most resemble and
 * rewritten IN PLACE, so a regenerated question keeps its id and its position.
 * That matters because the schedule references question ids: renumbering on
 * every regeneration would break the plan the user is working from.
 */
export function planMerge(live: MergeableItem[], candidates: MergeCandidate[]): MergePlan {
  const kept: MergeableItem[] = [];
  const replaceable: MergeableItem[] = [];

  for (const item of live) {
    if (item.status === 'superseded') continue;
    if (isProtected(item)) kept.push(item);
    else replaceable.push(item);
  }

  const actions: MergeAction[] = [];
  for (const item of kept) {
    actions.push({
      action: 'keep',
      publicId: item.publicId,
      reason: protectionReason(item) ?? 'pinned',
    });
  }

  // Greedy best-first matching, strictly one-to-one.
  const availableSlots = replaceable.filter((item) => item.status === 'active');
  const unmatchedCandidates: MergeCandidate[] = [];
  const usedSlots = new Set<string>();

  const pairs: { candidate: MergeCandidate; slot: MergeableItem; score: number }[] = [];
  for (const candidate of candidates) {
    for (const slot of availableSlots) {
      const score = similarity(candidate.matchText, slot.matchText);
      if (score >= MATCH_THRESHOLD) pairs.push({ candidate, slot, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const matchedCandidates = new Set<MergeCandidate>();
  for (const pair of pairs) {
    if (usedSlots.has(pair.slot.publicId) || matchedCandidates.has(pair.candidate)) continue;
    usedSlots.add(pair.slot.publicId);
    matchedCandidates.add(pair.candidate);
    actions.push({
      action: 'replace',
      publicId: pair.slot.publicId,
      expectedVersion: pair.slot.version,
      candidate: pair.candidate,
    });
  }

  for (const candidate of candidates) {
    if (matchedCandidates.has(candidate)) continue;
    // Do not clone something the user already wrote, and do not resurrect
    // something they deleted.
    const duplicatesProtected = kept.some(
      (item) => similarity(candidate.matchText, item.matchText) >= MATCH_THRESHOLD,
    );
    if (duplicatesProtected) continue;
    unmatchedCandidates.push(candidate);
    actions.push({ action: 'add', candidate });
  }

  // Replaceable items the model did not produce anything for are retired, not
  // hard-deleted, so the whole regeneration can be undone in one query.
  for (const slot of availableSlots) {
    if (usedSlots.has(slot.publicId)) continue;
    actions.push({ action: 'retire', publicId: slot.publicId, expectedVersion: slot.version });
  }

  return {
    actions,
    summary: {
      kept: kept.length,
      replaced: usedSlots.size,
      added: unmatchedCandidates.length,
      retired: availableSlots.length - usedSlots.size,
    },
    protectedTexts: kept.map((item) => item.matchText),
  };
}

/**
 * A short sentence stating the blast radius before the user commits.
 *
 * Shown in the confirm dialog. A regenerate button that does not say what it
 * will destroy is the reason people do not trust regenerate buttons.
 */
export function describeBlastRadius(live: MergeableItem[]): string {
  const active = live.filter((item) => item.status === 'active');
  const protectedCount = active.filter(isProtected).length;
  const replaceable = active.length - protectedCount;

  if (active.length === 0) return 'This section is empty, so nothing will be replaced.';
  if (protectedCount === 0) {
    return `All ${replaceable} item${replaceable === 1 ? '' : 's'} here will be replaced.`;
  }
  if (replaceable === 0) {
    return `Nothing will be replaced — all ${protectedCount} item${protectedCount === 1 ? '' : 's'} here are pinned or edited by you.`;
  }
  return `${replaceable} item${replaceable === 1 ? '' : 's'} will be replaced. ${protectedCount} you edited or pinned will be kept.`;
}
