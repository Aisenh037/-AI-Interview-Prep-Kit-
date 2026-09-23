'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useCreateKit } from '@/lib/hooks';

type Mode = 'single' | 'batch';

interface BatchRow {
  jd: string;
  companyUrl: string;
  days: number;
  error?: string;
}

export default function NewKitPage(): React.ReactElement {
  const router = useRouter();
  const create = useCreateKit();
  const [mode, setMode] = useState<Mode>('single');

  const [jd, setJd] = useState('');
  const [companyUrl, setCompanyUrl] = useState('');
  const [days, setDays] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ kitId: string; rescheduled: boolean } | null>(null);
  const [waking, setWaking] = useState(false);

  // The backend may be a sleeping free instance. Warming it while the user is
  // still typing means they do not meet a 45-second spinner on submit.
  useEffect(() => {
    setWaking(true);
    fetch('/api/backend/../healthz')
      .catch(() => undefined)
      .finally(() => setWaking(false));
  }, []);

  const submit = async (event: React.FormEvent, force = false): Promise<void> => {
    event.preventDefault();
    setError(null);
    setDuplicate(null);
    try {
      const result = await create.mutateAsync({ jd, companyUrl, days, force });
      if (result.duplicate && !force) {
        setDuplicate({ kitId: result.kitId, rescheduled: result.rescheduled === true });
        return;
      }
      router.push(`/kits/${result.kitId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the kit.');
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/kits" className="text-sm text-muted underline underline-offset-2">
        ← Your kits
      </Link>
      <h1 className="mt-3 text-2xl font-semibold text-ink">New prep kit</h1>

      <div className="mt-6 flex gap-1 rounded-lg bg-raised p-1" role="tablist">
        {(['single', 'batch'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
              mode === value ? 'bg-surface text-ink shadow-sm' : 'text-muted'
            }`}
          >
            {value === 'single' ? 'One role' : 'Several roles'}
          </button>
        ))}
      </div>

      <main id="main" className="mt-6">
        {mode === 'single' ? (
          <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
            <div>
              <label htmlFor="jd" className="mb-1 block text-sm font-medium text-ink">
                Job description
              </label>
              <textarea
                id="jd"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                rows={12}
                required
                placeholder="Paste the whole posting, including the requirements section."
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <p className="mt-1 text-xs text-muted">
                {jd.length} characters.{' '}
                {jd.length > 0 && jd.length < 400
                  ? 'Short postings produce short kits — we will not invent requirements to pad one out.'
                  : 'Paste it as text; we do not fetch from job boards.'}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div>
                <label htmlFor="url" className="mb-1 block text-sm font-medium text-ink">
                  Company website
                </label>
                <input
                  id="url"
                  type="url"
                  value={companyUrl}
                  onChange={(e) => setCompanyUrl(e.target.value)}
                  required
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ink"
                />
              </div>
              <div>
                <label htmlFor="days" className="mb-1 block text-sm font-medium text-ink">
                  Days until the interview
                </label>
                <input
                  id="days"
                  type="number"
                  min={1}
                  max={365}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="w-28 rounded-md border border-line bg-surface px-3 py-2 text-ink"
                />
              </div>
            </div>

            {duplicate !== null && (
              <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-3" role="status">
                <p className="text-sm text-ink">
                  {duplicate.rescheduled
                    ? 'You already have a kit for this posting. We have re-planned its schedule for the new number of days rather than researching it again.'
                    : 'You already have a kit for this posting.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link
                    href={`/kits/${duplicate.kitId}`}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
                  >
                    Open it
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => void submit(e, true)}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
                  >
                    Build a separate one anyway
                  </button>
                </div>
              </div>
            )}

            {error !== null && (
              <p className="rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={create.isPending || jd.trim() === '' || companyUrl.trim() === ''}
              className="rounded-md bg-accent px-5 py-2.5 font-medium text-accent-ink disabled:opacity-60"
            >
              {create.isPending ? 'Starting…' : 'Research and build'}
            </button>
            {waking && <p className="text-xs text-muted">Waking the research service…</p>}
          </form>
        ) : (
          <BatchForm />
        )}
      </main>
    </div>
  );
}

/**
 * Preparing for several roles at once.
 *
 * Rows are validated and shown BEFORE anything is submitted, so a malformed
 * file is a correction rather than five failed jobs. Submission is sequential
 * and the server caps concurrent generations, so twenty rows queue rather than
 * fanning out into a rate-limit wall.
 */
function BatchForm(): React.ReactElement {
  const router = useRouter();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(0);

  const parse = async (file: File): Promise<void> => {
    const text = await file.text();
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [];
      setRows(
        list.map((entry) => {
          const record = entry as Record<string, unknown>;
          const jd = String(record['jd'] ?? record['job_description'] ?? '');
          const companyUrl = String(record['company_url'] ?? record['companyUrl'] ?? '');
          const days = Number(record['days'] ?? 5);
          const problems: string[] = [];
          if (jd.trim() === '') problems.push('missing job description');
          if (companyUrl.trim() === '') problems.push('missing company URL');
          if (!Number.isFinite(days) || days < 1) problems.push('invalid days');
          return {
            jd,
            companyUrl,
            days: Number.isFinite(days) ? days : 5,
            ...(problems.length > 0 ? { error: problems.join(', ') } : {}),
          };
        }),
      );
    } catch {
      setRows([{ jd: '', companyUrl: '', days: 5, error: 'That file is not valid JSON.' }]);
    }
  };

  const valid = rows.filter((r) => r.error === undefined);

  const submitAll = async (): Promise<void> => {
    setSubmitting(true);
    let first: string | null = null;
    for (const row of valid) {
      try {
        const result = await api.post<{ kitId: string }>('/kits', {
          jd: row.jd,
          companyUrl: row.companyUrl,
          days: row.days,
        });
        first ??= result.kitId;
      } catch {
        // One bad row must not stop the rest.
      }
      setDone((n) => n + 1);
    }
    setSubmitting(false);
    router.push(first === null ? '/kits' : '/kits');
  };

  return (
    <div className="space-y-4">
      <div className="rounded-card border border-dashed border-line p-6 text-center">
        <label htmlFor="file" className="cursor-pointer text-sm font-medium text-accent">
          Choose a JSON file
        </label>
        <input
          id="file"
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void parse(file);
          }}
        />
        <p className="mt-2 text-xs text-muted">
          An array of objects with <code>jd</code>, <code>company_url</code> and <code>days</code> —
          the same shape the batch command accepts.
        </p>
      </div>

      {rows.length > 0 && (
        <>
          <ul className="divide-y divide-line rounded-card border border-line">
            {rows.map((row, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {row.companyUrl || '(no URL)'} · {row.days}d
                </span>
                {row.error === undefined ? (
                  <span className="text-xs text-good">ready</span>
                ) : (
                  <span className="text-xs text-bad">{row.error}</span>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={submitting || valid.length === 0}
            onClick={() => void submitAll()}
            className="rounded-md bg-accent px-5 py-2.5 font-medium text-accent-ink disabled:opacity-60"
          >
            {submitting ? `Queuing ${done}/${valid.length}…` : `Build ${valid.length} kit(s)`}
          </button>
          <p className="text-xs text-muted">
            These queue rather than running at once, so a large file does not run into the model
            provider&rsquo;s rate limits.
          </p>
        </>
      )}
    </div>
  );
}
