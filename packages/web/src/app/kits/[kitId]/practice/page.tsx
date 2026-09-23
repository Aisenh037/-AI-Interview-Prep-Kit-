'use client';

/**
 * Practice mode.
 *
 * Grading is optimistic and fire-and-forget: the card advances immediately and
 * the review is posted in the background. Waiting on a round-trip between every
 * card is what makes a flashcard app feel like a form.
 *
 * Every card shows WHY it is in front of you. The ordering rule is explainable
 * by design, and a ranking you can justify is worth more than one you cannot.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

interface SessionCard {
  cardId: string;
  front: string;
  back: string;
  requirementIds: string[];
  reason: string;
}

interface SessionPayload {
  cards: SessionCard[];
  stats: { total: number; seen: number; confident: number; shaky: number; unseen: number };
}

const GRADES = [
  { value: 0, label: 'Again', hint: 'drew a blank', className: 'bg-bad/10 text-bad' },
  { value: 1, label: 'Hard', hint: 'got there slowly', className: 'bg-warn/10 text-warn' },
  { value: 2, label: 'Good', hint: 'solid', className: 'bg-accent/10 text-accent' },
  { value: 3, label: 'Easy', hint: 'instant', className: 'bg-good/10 text-good' },
] as const;

export default function PracticePage(): React.ReactElement {
  const params = useParams<{ kitId: string }>();
  const kitId = params.kitId;

  const session = useQuery({
    queryKey: ['practice', kitId],
    queryFn: () => api.get<SessionPayload>(`/practice/${kitId}/session?limit=20`),
  });

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState<Record<string, number>>({});

  const cards = session.data?.cards ?? [];
  const card = cards[index];

  const grade = useCallback(
    (confidence: number): void => {
      if (card === undefined) return;
      setGraded((g) => ({ ...g, [card.cardId]: confidence }));
      // Fire and forget, with the UI already moved on.
      void api.post(`/practice/${kitId}/reviews`, { cardId: card.cardId, confidence }).catch(() => undefined);
      setRevealed(false);
      setIndex((i) => i + 1);
    },
    [card, kitId],
  );

  // A documented key map, because the whole point of a flashcard stepper is
  // that your hands never leave the keyboard.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setRevealed((r) => !r);
      }
      if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        grade(Number(event.key) - 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [revealed, grade]);

  if (session.isPending) {
    return <main className="mx-auto max-w-2xl px-6 py-10 text-muted">Loading…</main>;
  }

  const stats = session.data?.stats;
  const finished = index >= cards.length;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href={`/kits/${kitId}`} className="text-sm text-muted underline underline-offset-2">
        ← Back to the kit
      </Link>

      <header className="mb-6 mt-3">
        <h1 className="text-2xl font-semibold text-ink">Practice</h1>
        {stats !== undefined && (
          <p className="mt-1 text-sm text-muted">
            {stats.seen} of {stats.total} cards practised · {stats.shaky} shaky · {stats.unseen} not
            yet seen
          </p>
        )}
      </header>

      <main id="main">
        {cards.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
            <h2 className="font-medium text-ink">No flashcards to practise</h2>
            <p className="mt-1 text-sm text-muted">
              This kit has no cards yet. Add some in the flashcards tab.
            </p>
          </div>
        ) : finished ? (
          <Summary
            graded={graded}
            total={cards.length}
            onAgain={() => {
              setIndex(0);
              setGraded({});
              void session.refetch();
            }}
            kitId={kitId}
          />
        ) : (
          card !== undefined && (
            <>
              <div
                className="rounded-card border border-line bg-surface p-6"
                role="group"
                aria-roledescription="flashcard"
                aria-label={`Card ${index + 1} of ${cards.length}`}
              >
                <p className="mb-3 text-xs text-muted">{card.reason}</p>
                <p className="text-lg font-medium text-ink">{card.front}</p>

                {revealed ? (
                  <div className="mt-4 border-t border-line pt-4" aria-live="polite">
                    <p className="whitespace-pre-wrap text-ink">{card.back}</p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    aria-expanded={false}
                    className="mt-4 w-full rounded-md border border-line py-2.5 text-sm font-medium text-ink hover:bg-raised"
                  >
                    Show answer <kbd className="ml-1 text-xs text-muted">space</kbd>
                  </button>
                )}
              </div>

              {revealed && (
                <div className="mt-4" role="group" aria-label="How confident were you?">
                  <p className="mb-2 text-sm text-muted">How confident were you?</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {GRADES.map((g, i) => (
                      <button
                        key={g.value}
                        type="button"
                        onClick={() => grade(g.value)}
                        aria-keyshortcuts={String(i + 1)}
                        className={`rounded-md px-3 py-2.5 text-sm font-medium ${g.className}`}
                      >
                        <span className="block">{g.label}</span>
                        <span className="block text-[11px] font-normal opacity-70">{g.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6">
                <div
                  role="progressbar"
                  aria-valuenow={index}
                  aria-valuemin={0}
                  aria-valuemax={cards.length}
                  aria-label="Session progress"
                  className="h-1.5 overflow-hidden rounded-full bg-raised"
                >
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${(index / cards.length) * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {index} of {cards.length}
                </p>
              </div>
            </>
          )
        )}
      </main>
    </div>
  );
}

function Summary(props: {
  graded: Record<string, number>;
  total: number;
  onAgain: () => void;
  kitId: string;
}): React.ReactElement {
  const values = Object.values(props.graded);
  const shaky = values.filter((v) => v <= 1).length;

  return (
    <div className="rounded-card border border-line bg-surface p-6 text-center">
      <h2 className="text-lg font-medium text-ink">Session done</h2>
      <p className="mt-1 text-sm text-muted">
        {props.total} cards · {shaky} still shaky
      </p>
      <p className="mx-auto mt-3 max-w-sm text-sm text-muted">
        {shaky === 0
          ? 'Everything landed. The next session will space these out rather than drilling them again.'
          : 'The next session will lead with the ones you found hardest, and nothing is scheduled past your interview.'}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={props.onAgain}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
        >
          Another session
        </button>
        <Link
          href={`/kits/${props.kitId}`}
          className="rounded-md border border-line px-4 py-2 text-sm text-ink"
        >
          Back to the kit
        </Link>
      </div>
    </div>
  );
}
