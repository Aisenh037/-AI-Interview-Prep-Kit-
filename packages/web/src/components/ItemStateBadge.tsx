'use client';

import type { KitItemView } from '@/lib/api';

/**
 * Where an item came from, and whether a regeneration can touch it.
 *
 * Colour is never the only channel — each state carries a word — because the
 * distinction between "this will be replaced" and "this is safe" is exactly the
 * one a colour-blind user must not have to guess at.
 */
export function ItemStateBadge({ item }: { item: KitItemView }): React.ReactElement | null {
  const state = deriveState(item);
  if (state === null) return null;

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${state.className}`}
      title={state.title}
    >
      {state.label}
    </span>
  );
}

function deriveState(
  item: KitItemView,
): { label: string; title: string; className: string } | null {
  if (item.pinned) {
    return {
      label: 'Pinned',
      title: 'Pinned — regenerating this section will keep it',
      className: 'bg-accent/10 text-accent',
    };
  }
  if (item.createdBy === 'user') {
    return {
      label: 'Yours',
      title: 'You wrote this — regenerating will keep it',
      className: 'bg-good/10 text-good',
    };
  }
  if (item.lastEditedBy === 'user' || item.editedFields.length > 0) {
    return {
      label: 'Edited',
      title: 'You edited this — regenerating will keep it',
      className: 'bg-good/10 text-good',
    };
  }
  if (item.movedByUser) {
    return {
      label: 'Moved',
      title: 'You moved this — regenerating will keep it',
      className: 'bg-good/10 text-good',
    };
  }
  // Generated and untouched: the only state a regeneration may replace. Left
  // unlabelled so the badges mean "protected" at a glance.
  return null;
}
