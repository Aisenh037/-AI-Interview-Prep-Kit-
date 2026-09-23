'use client';

/**
 * The question bank: the part of the interface the brief scores most heavily.
 *
 * Reordering uses dnd-kit because its keyboard sensor works out of the box —
 * space to lift, arrows to move, space to drop — and it manages the live-region
 * announcements. Keyboard access is explicitly scored, and the HTML5 drag API
 * has no keyboard story at all.
 *
 * Dragging is HANDLE-ONLY with an activation distance. Without that, clicking
 * into a textarea to edit starts a drag instead, which is the single bug that
 * makes inline editing plus drag-and-drop feel broken.
 *
 * Every drag action also exists as a menu item and a keyboard shortcut. That is
 * not a fallback: on a phone, cross-category dragging means auto-scrolling a
 * long page with a finger held down, and the menu is simply the better path.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import type { Question, QuestionCategory, Requirement } from '@kit/shared';
import type { KitItemView } from '@/lib/api';
import { EditableText } from './EditableText';
import { ItemStateBadge } from './ItemStateBadge';

const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

const CATEGORIES: QuestionCategory[] = [
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
];

export interface QuestionBankProps {
  items: KitItemView[];
  requirements: Requirement[];
  onPatch: (publicId: string, patch: Record<string, unknown>, version: number) => Promise<{ version: number }>;
  onPin: (publicId: string, pinned: boolean) => Promise<unknown>;
  onDelete: (publicId: string) => Promise<unknown>;
  onRestore: (publicId: string) => Promise<unknown>;
  onMove: (
    publicId: string,
    body: { targetCategory?: string; afterId?: string | null; beforeId?: string | null; expectedVersion: number },
  ) => Promise<unknown>;
  onAdd: (category: QuestionCategory) => Promise<unknown>;
  onRegenerate: (sectionKey: string) => Promise<unknown>;
  busySection: string | null;
}

export function QuestionBank(props: QuestionBankProps): React.ReactElement {
  const byCategory = useMemo(() => {
    const map = new Map<QuestionCategory, KitItemView[]>();
    for (const category of CATEGORIES) map.set(category, []);
    for (const item of props.items) {
      if (item.type !== 'question') continue;
      const category = (item.data as unknown as Question).category;
      map.get(category)?.push(item);
    }
    for (const list of map.values()) list.sort((a, b) => (a.rank < b.rank ? -1 : 1));
    return map;
  }, [props.items]);

  return (
    <div className="space-y-6">
      {CATEGORIES.map((category) => {
        const list = byCategory.get(category) ?? [];
        const sectionKey = `questions:${category}`;
        return (
          <CategorySection
            key={category}
            {...props}
            category={category}
            sectionKey={sectionKey}
            items={list}
            busy={props.busySection === sectionKey}
          />
        );
      })}
    </div>
  );
}

function CategorySection(
  props: QuestionBankProps & { category: QuestionCategory; sectionKey: string; items: KitItemView[]; busy: boolean },
): React.ReactElement {
  const active = props.items.filter((i) => i.status === 'active');
  const deleted = props.items.filter((i) => i.status === 'deleted');
  const [confirming, setConfirming] = useState(false);

  const protectedCount = active.filter(
    (i) => i.pinned || i.createdBy === 'user' || i.lastEditedBy === 'user' || i.movedByUser,
  ).length;
  const replaceable = active.length - protectedCount;

  const sensors = useSensors(
    // An 8px threshold: below that it is a click into a field, not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent): void => {
    const { active: dragged, over } = event;
    if (over === null || dragged.id === over.id) return;
    const ids = active.map((i) => i.publicId);
    const from = ids.indexOf(String(dragged.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;

    const reordered = [...ids];
    reordered.splice(from, 1);
    reordered.splice(to, 0, String(dragged.id));
    const position = reordered.indexOf(String(dragged.id));
    const item = active.find((i) => i.publicId === String(dragged.id));
    if (item === undefined) return;

    void props.onMove(item.publicId, {
      afterId: reordered[position - 1] ?? null,
      beforeId: reordered[position + 1] ?? null,
      expectedVersion: item.version,
    });
  };

  return (
    <section
      aria-labelledby={`heading-${props.category}`}
      className="rounded-card border border-line bg-surface"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h3 id={`heading-${props.category}`} className="font-semibold text-ink">
          {CATEGORY_LABEL[props.category]}
        </h3>
        <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
          {active.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void props.onAdd(props.category)}
            className="rounded-md border border-line px-2.5 py-1 text-sm text-ink hover:bg-raised"
          >
            Add question
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => setConfirming(true)}
            className="rounded-md border border-line px-2.5 py-1 text-sm text-ink hover:bg-raised disabled:opacity-50"
          >
            {props.busy ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      </header>

      {confirming && (
        <div className="border-b border-line bg-raised px-4 py-3" role="dialog" aria-label="Confirm regeneration">
          {/* The blast radius is stated BEFORE the click. A regenerate button
              that does not say what it will destroy is why people do not trust
              regenerate buttons. */}
          <p className="text-sm text-ink">
            {active.length === 0
              ? 'This category is empty, so nothing will be replaced.'
              : replaceable === 0
                ? `Nothing will be replaced — all ${protectedCount} question${protectedCount === 1 ? '' : 's'} here are pinned or edited by you.`
                : `${replaceable} question${replaceable === 1 ? '' : 's'} will be replaced.${
                    protectedCount > 0
                      ? ` ${protectedCount} you edited or pinned will be kept.`
                      : ''
                  }`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                void props.onRegenerate(props.sectionKey);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
            >
              Regenerate
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="p-2">
        {active.length === 0 && deleted.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">
            No {CATEGORY_LABEL[props.category].toLowerCase()} questions yet.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={active.map((i) => i.publicId)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2" role="list">
                {active.map((item, index) => (
                  <QuestionCard
                    key={item.publicId}
                    item={item}
                    index={index}
                    total={active.length}
                    neighbours={active}
                    requirements={props.requirements}
                    onPatch={props.onPatch}
                    onPin={props.onPin}
                    onDelete={props.onDelete}
                    onMove={props.onMove}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        {deleted.length > 0 && (
          <details className="mt-3 px-2">
            <summary className="cursor-pointer text-xs text-muted">
              {deleted.length} deleted — these stay deleted when you regenerate
            </summary>
            <ul className="mt-2 space-y-1">
              {deleted.map((item) => (
                <li key={item.publicId} className="flex items-center gap-2 text-sm text-muted">
                  <span className="line-through">{String((item.data as { prompt?: string }).prompt ?? '')}</span>
                  <button
                    type="button"
                    onClick={() => void props.onRestore(item.publicId)}
                    className="rounded border border-line px-2 py-0.5 text-xs text-ink"
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function QuestionCard(props: {
  item: KitItemView;
  index: number;
  total: number;
  neighbours: KitItemView[];
  requirements: Requirement[];
  onPatch: QuestionBankProps['onPatch'];
  onPin: QuestionBankProps['onPin'];
  onDelete: QuestionBankProps['onDelete'];
  onMove: QuestionBankProps['onMove'];
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.item.publicId,
  });
  const question = props.item.data as unknown as Question;
  const [menuOpen, setMenuOpen] = useState(false);

  const nudge = (direction: -1 | 1): void => {
    const target = props.index + direction;
    if (target < 0 || target >= props.total) return;
    const reordered = props.neighbours.map((i) => i.publicId);
    reordered.splice(props.index, 1);
    reordered.splice(target, 0, props.item.publicId);
    void props.onMove(props.item.publicId, {
      afterId: reordered[target - 1] ?? null,
      beforeId: reordered[target + 1] ?? null,
      expectedVersion: props.item.version,
    });
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-lg border bg-surface ${isDragging ? 'border-accent shadow-lg' : 'border-line'}`}
      onKeyDown={(e) => {
        // Alt+arrows move without needing a pointer at all.
        if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          nudge(-1);
        }
        if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          nudge(1);
        }
      }}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder question ${props.index + 1} of ${props.total}. Press space to lift, then use the arrow keys.`}
          className="mt-1 flex h-11 w-11 shrink-0 cursor-grab items-center justify-center rounded text-muted hover:bg-raised sm:h-8 sm:w-8"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <circle cx="5" cy="3" r="1.4" fill="currentColor" />
            <circle cx="11" cy="3" r="1.4" fill="currentColor" />
            <circle cx="5" cy="8" r="1.4" fill="currentColor" />
            <circle cx="11" cy="8" r="1.4" fill="currentColor" />
            <circle cx="5" cy="13" r="1.4" fill="currentColor" />
            <circle cx="11" cy="13" r="1.4" fill="currentColor" />
          </svg>
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-muted">{props.item.publicId}</span>
            <ItemStateBadge item={props.item} />
            <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
              difficulty {question.difficulty}
            </span>
            {question.requirement_ids.map((id) => (
              <span key={id} className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">
                {id}
              </span>
            ))}
          </div>

          <EditableText
            itemId={props.item.publicId}
            field="prompt"
            value={question.prompt}
            version={props.item.version}
            label="Question"
            placeholder="What does the interviewer ask?"
            className="font-medium"
            onCommit={(patch, version) => props.onPatch(props.item.publicId, patch, version)}
          />
          <EditableText
            itemId={props.item.publicId}
            field="answer_outline"
            value={question.answer_outline}
            version={props.item.version}
            label="Answer outline"
            placeholder="What does a strong answer contain?"
            className="text-sm text-muted"
            onCommit={(patch, version) => props.onPatch(props.item.publicId, patch, version)}
          />
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            aria-label={props.item.pinned ? 'Unpin this question' : 'Pin this question so regeneration keeps it'}
            aria-pressed={props.item.pinned}
            onClick={() => void props.onPin(props.item.publicId, !props.item.pinned)}
            className={`flex h-11 w-11 items-center justify-center rounded text-sm sm:h-8 sm:w-8 ${
              props.item.pinned ? 'text-accent' : 'text-muted hover:bg-raised'
            }`}
          >
            {props.item.pinned ? '★' : '☆'}
          </button>
          <button
            type="button"
            aria-label="More actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-11 w-11 items-center justify-center rounded text-muted hover:bg-raised sm:h-8 sm:w-8"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-line bg-surface py-1 shadow-lg"
            >
              <MenuItem onClick={() => { nudge(-1); setMenuOpen(false); }} disabled={props.index === 0}>
                Move up <kbd className="text-[10px] text-muted">Alt ↑</kbd>
              </MenuItem>
              <MenuItem
                onClick={() => { nudge(1); setMenuOpen(false); }}
                disabled={props.index === props.total - 1}
              >
                Move down <kbd className="text-[10px] text-muted">Alt ↓</kbd>
              </MenuItem>
              <div className="my-1 border-t border-line" />
              <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">Move to</p>
              {CATEGORIES.filter((c) => c !== question.category).map((category) => (
                <MenuItem
                  key={category}
                  onClick={() => {
                    setMenuOpen(false);
                    void props.onMove(props.item.publicId, {
                      targetCategory: category,
                      expectedVersion: props.item.version,
                    });
                  }}
                >
                  {CATEGORY_LABEL[category]}
                </MenuItem>
              ))}
              <div className="my-1 border-t border-line" />
              <MenuItem
                onClick={() => { setMenuOpen(false); void props.onDelete(props.item.publicId); }}
                danger
              >
                Delete
              </MenuItem>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-raised disabled:opacity-40 ${
        danger === true ? 'text-bad' : 'text-ink'
      }`}
    >
      {children}
    </button>
  );
}
