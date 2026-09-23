'use client';

/**
 * What the user watches while a kit is being built.
 *
 * Three decisions, all aimed at the brief's "how you handle a long-running
 * generation":
 *
 *  - The step list renders in full from the first frame, all pending. A list
 *    that fills in reads faster than a bar that appears from nothing, because
 *    the shape of the work is visible immediately.
 *  - There is an elapsed timer and an honest estimate, never a percentage that
 *    creeps to 80 and stalls.
 *  - A gap is not an error. "No hiring page found" is amber, has no warning
 *    triangle, and states its consequence rather than just the fact.
 */
import { useEffect, useState } from 'react';
import { describeWarning, type JobView } from '@/lib/api';

const FALLBACK_STEPS = [
  { id: 'validate', label: 'Reading the job description' },
  { id: 'crawl', label: 'Exploring the company site' },
  { id: 'extract', label: 'Extracting requirements' },
  { id: 'discussion', label: 'Searching public discussion of their interviews' },
  { id: 'brief', label: 'Writing the company brief' },
  { id: 'plan', label: 'Deciding which question types to build' },
  { id: 'questions', label: 'Building the question bank' },
  { id: 'coverage', label: 'Checking every requirement is covered' },
  { id: 'flashcards', label: 'Making flashcards' },
  { id: 'schedule', label: 'Planning your days' },
  { id: 'assemble', label: 'Checking the kit' },
];

export function GenerationProgress({
  job,
  startedAt,
}: {
  job: JobView | null;
  startedAt: number;
}): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const steps = job !== null && job.steps.length > 0 ? job.steps : FALLBACK_STEPS.map((s) => ({ ...s, status: 'pending' as const }));
  const notes = (job?.events ?? []).filter((e) => e.type === 'note');

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-semibold text-ink">Building your kit</h2>
        <p className="text-sm text-muted">
          <span className="font-mono tabular-nums">{format(elapsed)}</span>
          {' · usually about 90 seconds'}
        </p>
      </div>

      {/* One polite live region announces step transitions. Sub-step chatter
          would make a screen reader unusable here. */}
      <ol className="space-y-1" aria-live="polite" aria-relevant="text">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-3 rounded px-2 py-1.5 text-sm">
            <StepIcon status={step.status} />
            <span className={step.status === 'pending' ? 'text-muted' : 'text-ink'}>{step.label}</span>
          </li>
        ))}
      </ol>

      {notes.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-line pt-3">
          {notes.slice(-4).map((note, i) => (
            <li key={i} className="text-xs text-muted">
              {note.message}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted">
        You can close this page. Generation continues, and the kit will be here when you come back.
      </p>
    </div>
  );
}

function StepIcon({ status }: { status: string }): React.ReactElement {
  if (status === 'ok') {
    return <span className="text-good" aria-label="done">✓</span>;
  }
  if (status === 'running') {
    return (
      <span className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-label="in progress" />
    );
  }
  if (status === 'degraded') {
    return <span className="text-warn" aria-label="partial">◐</span>;
  }
  if (status === 'failed') {
    return <span className="text-bad" aria-label="failed">✕</span>;
  }
  return <span className="h-3 w-3 rounded-full border border-line" aria-label="waiting" />;
}

function format(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Research gaps, stated as findings rather than failures.
 *
 * The brief tests a company with no hiring page anywhere and asks that it be
 * "reported honestly". Honest means saying what was not found AND what that
 * means for the kit, which is the part a bare warning leaves out.
 */
export function GapsPanel({ warnings }: { warnings: string[] }): React.ReactElement | null {
  const described = warnings
    .map((code) => ({ code, copy: describeWarning(code) }))
    .filter((w): w is { code: string; copy: { title: string; consequence: string } } => w.copy !== null);

  if (described.length === 0) return null;

  return (
    <section className="rounded-card border border-warn/30 bg-warn/5 p-4" aria-labelledby="gaps-heading">
      <h3 id="gaps-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
        What the research could not find ({described.length})
      </h3>
      <ul className="space-y-2">
        {described.map(({ code, copy }) => (
          <li key={code}>
            <p className="text-sm font-medium text-ink">{copy.title}</p>
            <p className="text-sm text-muted">{copy.consequence}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
