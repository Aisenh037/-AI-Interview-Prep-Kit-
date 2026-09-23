'use client';

/**
 * The kit workspace.
 *
 * Generation renders IN PLACE rather than on a separate waiting screen, and each
 * section becomes editable the moment it lands. That turns a ninety-second wait
 * into a twenty-second wait plus background activity, which is a better answer
 * to "how you handle a long-running generation" than any spinner.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { QuestionCategory } from '@kit/shared';
import { GapsPanel, GenerationProgress } from '@/components/GenerationProgress';
import { QuestionBank } from '@/components/QuestionBank';
import { EditableText } from '@/components/EditableText';
import { api } from '@/lib/api';
import { useItemPatch, useKit, useStructuralMutation } from '@/lib/hooks';

type Tab = 'overview' | 'questions' | 'flashcards' | 'schedule';

export default function KitPage(): React.ReactElement {
  const params = useParams<{ kitId: string }>();
  const kitId = params.kitId;
  const query = useKit(kitId);
  const patch = useItemPatch(kitId);
  const mutate = useStructuralMutation(kitId);
  const [tab, setTab] = useState<Tab>('overview');
  const [startedAt] = useState(() => Date.now());

  const detail = query.data;
  const busySection = detail?.job?.status === 'running' ? (detail.job.sectionKey ?? 'all') : null;

  const requirements = useMemo(
    () => detail?.kit?.role.requirements ?? [],
    [detail?.kit?.role.requirements],
  );

  if (query.isPending) {
    return <main id="main" className="mx-auto max-w-5xl px-6 py-10 text-muted">Loading…</main>;
  }

  if (query.isError || detail === undefined) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <p className="rounded-card border border-bad/30 bg-bad/5 p-6 text-ink" role="alert">
          That kit could not be loaded. It may have been deleted.
        </p>
        <Link href="/kits" className="mt-4 inline-block text-sm text-accent underline">
          Back to your kits
        </Link>
      </main>
    );
  }

  const generating = detail.status === 'queued' || detail.status === 'generating';

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <Link href="/kits" className="text-sm text-muted underline underline-offset-2">
          ← Your kits
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold text-ink">{detail.title || 'Preparing…'}</h1>
          <span className="text-sm text-muted">{detail.input.days} days to prepare</span>
          {detail.kit !== null && (
            <div className="ml-auto flex gap-2">
              <Link
                href={`/kits/${kitId}/practice`}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
              >
                Practise
              </Link>
              <a
                href={`/api/backend/kits/${kitId}/export`}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
              >
                Export JSON
              </a>
            </div>
          )}
        </div>
      </header>

      <main id="main" className="space-y-6">
        {generating && <GenerationProgress job={detail.job} startedAt={startedAt} />}

        {detail.status === 'failed' && (
          <div className="rounded-card border border-bad/30 bg-bad/5 p-5" role="alert">
            <h2 className="font-medium text-ink">Generation stopped</h2>
            <p className="mt-1 text-sm text-muted">
              {detail.job?.error?.message ?? 'Something went wrong while building this kit.'}
            </p>
            <button
              type="button"
              onClick={() => void mutate.regenerate('questions:technical')}
              className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink"
            >
              Try again
            </button>
          </div>
        )}

        <GapsPanel warnings={detail.warnings} />

        {detail.kit !== null && (
          <>
            <nav className="flex gap-1 overflow-x-auto rounded-lg bg-raised p-1" role="tablist">
              {(['overview', 'questions', 'flashcards', 'schedule'] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
                    tab === value ? 'bg-surface text-ink shadow-sm' : 'text-muted'
                  }`}
                >
                  {value}
                </button>
              ))}
            </nav>

            {tab === 'overview' && (
              <Overview
                kitId={kitId}
                kit={detail.kit}
                research={detail.research}
                onRegenerate={() => void mutate.regenerate('brief')}
                busy={busySection === 'brief'}
              />
            )}

            {tab === 'questions' && (
              <QuestionBank
                items={detail.items}
                requirements={requirements}
                busySection={busySection}
                onPatch={(publicId, p, version) => patch(publicId, p, version)}
                onPin={mutate.pin}
                onDelete={mutate.remove}
                onRestore={mutate.restore}
                onMove={mutate.move}
                onAdd={(category: QuestionCategory) =>
                  mutate.add('question', category, {
                    prompt: 'New question',
                    answer_outline: '',
                    difficulty: 2,
                  })
                }
                onRegenerate={mutate.regenerate}
              />
            )}

            {tab === 'flashcards' && (
              <Flashcards
                items={detail.items}
                onPatch={(publicId, p, version) => patch(publicId, p, version)}
                onDelete={mutate.remove}
                onAdd={() => mutate.add('flashcard', undefined, { front: 'New card', back: '' })}
              />
            )}

            {tab === 'schedule' && (
              <Schedule
                kit={detail.kit}
                busy={busySection === 'schedule'}
                onRegenerate={() => void mutate.regenerate('schedule')}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Overview(props: {
  kitId: string;
  kit: NonNullable<import('@/lib/api').KitDetail['kit']>;
  research: import('@/lib/api').KitDetail['research'];
  onRegenerate: () => void;
  busy: boolean;
}): React.ReactElement {
  const { kit } = props;
  const uncovered = new Set(kit.coverage.uncovered_requirement_ids);

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-5">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-semibold text-ink">About {kit.source.company}</h2>
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onRegenerate}
            className="ml-auto rounded-md border border-line px-2.5 py-1 text-sm text-ink disabled:opacity-50"
          >
            {props.busy ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
        <EditableText
          itemId="brief"
          field="summary"
          value={kit.company_brief.summary}
          version={0}
          label="Company summary"
          onCommit={async (patch) => {
            await api.patch(`/kits/${props.kitId}/brief`, { patch });
            return { version: 0 };
          }}
        />
        <EditableText
          itemId="brief"
          field="what_they_do"
          value={kit.company_brief.what_they_do}
          version={0}
          label="What they do"
          className="text-sm text-muted"
          onCommit={async (patch) => {
            await api.patch(`/kits/${props.kitId}/brief`, { patch });
            return { version: 0 };
          }}
        />
        {kit.company_brief.sources.length > 0 ? (
          <p className="mt-2 text-xs text-muted">
            Read from {kit.company_brief.sources.length} page(s) we fetched ourselves.
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            No sources — nothing could be retrieved, and nothing here is invented to fill the gap.
          </p>
        )}
      </section>

      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="mb-3 font-semibold text-ink">
          Requirements{' '}
          <span className="text-sm font-normal text-muted">
            ({kit.role.requirements.filter((r) => r.priority === 'must').length} must-have)
          </span>
        </h2>
        {kit.role.requirements.length === 0 ? (
          <p className="text-sm text-muted">
            The posting stated no extractable requirements. Nothing has been invented to fill the
            space.
          </p>
        ) : (
          <ul className="space-y-2">
            {kit.role.requirements.map((requirement) => (
              <li key={requirement.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono text-xs text-muted">{requirement.id}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    requirement.priority === 'must'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-raised text-muted'
                  }`}
                >
                  {requirement.priority}
                </span>
                <span className="text-ink">{requirement.text}</span>
                {uncovered.has(requirement.id) && (
                  <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
                    no question yet
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {props.research !== null && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="mb-2 font-semibold text-ink">Research log</h2>
          <p className="text-sm text-muted">
            {props.research.pagesFetched} page(s) read ·{' '}
            {props.research.hiringPageFound ? 'hiring process found' : 'no hiring process published'} ·{' '}
            {props.research.discussionFound ? 'public discussion found' : 'no public discussion found'}
          </p>
          {props.research.rationale.length > 0 && (
            <ul className="mt-2 space-y-1">
              {props.research.rationale.map((line, i) => (
                <li key={i} className="text-sm text-ink">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {props.research.hiringPageUrl !== null && (
            <p className="mt-2 truncate text-xs text-muted">{props.research.hiringPageUrl}</p>
          )}
        </section>
      )}
    </div>
  );
}

function Flashcards(props: {
  items: import('@/lib/api').KitItemView[];
  onPatch: (publicId: string, patch: Record<string, unknown>, version: number) => Promise<{ version: number }>;
  onDelete: (publicId: string) => Promise<unknown>;
  onAdd: () => Promise<unknown>;
}): React.ReactElement {
  const cards = props.items
    .filter((i) => i.type === 'flashcard' && i.status === 'active')
    .sort((a, b) => (a.rank < b.rank ? -1 : 1));

  return (
    <section className="rounded-card border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold text-ink">Flashcards</h2>
        <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">{cards.length}</span>
        <button
          type="button"
          onClick={() => void props.onAdd()}
          className="ml-auto rounded-md border border-line px-2.5 py-1 text-sm text-ink"
        >
          Add card
        </button>
      </header>
      {cards.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No flashcards yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {cards.map((card) => {
            const data = card.data as { front: string; back: string };
            return (
              <li key={card.publicId} className="p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-[11px] text-muted">{card.publicId}</span>
                  <button
                    type="button"
                    onClick={() => void props.onDelete(card.publicId)}
                    className="ml-auto text-xs text-muted hover:text-bad"
                  >
                    Delete
                  </button>
                </div>
                <EditableText
                  itemId={card.publicId}
                  field="front"
                  value={data.front}
                  version={card.version}
                  label="Front"
                  className="font-medium"
                  onCommit={(patch, version) => props.onPatch(card.publicId, patch, version)}
                />
                <EditableText
                  itemId={card.publicId}
                  field="back"
                  value={data.back}
                  version={card.version}
                  label="Back"
                  className="text-sm text-muted"
                  onCommit={(patch, version) => props.onPatch(card.publicId, patch, version)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Schedule(props: {
  kit: NonNullable<import('@/lib/api').KitDetail['kit']>;
  busy: boolean;
  onRegenerate: () => void;
}): React.ReactElement {
  const byId = new Map(props.kit.questions.map((q) => [q.id, q]));

  return (
    <section className="rounded-card border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold text-ink">
          {props.kit.schedule.days.length}-day plan
        </h2>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onRegenerate}
          className="ml-auto rounded-md border border-line px-2.5 py-1 text-sm text-ink disabled:opacity-50"
        >
          {props.busy ? 'Re-planning…' : 'Re-plan'}
        </button>
      </header>
      <ol className="divide-y divide-line">
        {props.kit.schedule.days.map((day) => (
          <li key={day.day} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold text-ink">Day {day.day}</span>
              <span className="text-sm text-ink">{day.focus}</span>
              <span className="ml-auto text-xs text-muted">{day.minutes} min</span>
            </div>
            {day.question_ids.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {day.question_ids.map((id) => (
                  <li key={id} className="truncate text-xs text-muted">
                    <span className="font-mono">{id}</span> · {byId.get(id)?.prompt ?? ''}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
