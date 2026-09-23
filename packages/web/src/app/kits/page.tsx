'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, api } from '@/lib/api';
import { useKits, useSession } from '@/lib/hooks';

export default function KitsPage(): React.ReactElement {
  const router = useRouter();
  const session = useSession();
  const kits = useKits();

  // A signed-out visitor never sees a protected page. The API is the real
  // boundary; this just avoids a flash of empty chrome.
  useEffect(() => {
    if (session.isError && session.error instanceof ApiError && session.error.isUnauthenticated) {
      router.replace('/login?next=/kits');
    }
  }, [session.isError, session.error, router]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Your kits</h1>
          <p className="text-sm text-muted">
            {session.data === undefined ? ' ' : `Signed in as ${session.data.email}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/kits/new"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
          >
            New kit
          </Link>
          <button
            type="button"
            onClick={async () => {
              await api.post('/auth/logout');
              router.push('/login');
            }}
            className="rounded-md border border-line px-3 py-2 text-sm text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <main id="main">
        {kits.isPending && <SkeletonList />}

        {kits.isError && (
          <ErrorState
            message="Could not load your kits."
            onRetry={() => void kits.refetch()}
          />
        )}

        {kits.data !== undefined && kits.data.length === 0 && (
          <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
            <h2 className="font-medium text-ink">No kits yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              Paste a job description and a company website, say how long you have, and the app
              will research the company and build a prep kit.
            </p>
            <Link
              href="/kits/new"
              className="mt-4 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
            >
              Create your first kit
            </Link>
          </div>
        )}

        <ul className="space-y-3">
          {(kits.data ?? []).map((kit) => (
            <li key={kit.id}>
              <Link
                href={`/kits/${kit.id}`}
                className="block rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-ink">{kit.title || 'Untitled kit'}</span>
                  <StatusChip status={kit.status} progress={kit.job?.progress} />
                  <span className="ml-auto text-sm text-muted">{kit.days} days</span>
                </div>
                <p className="mt-1 truncate text-sm text-muted">{kit.companyUrl}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function StatusChip({ status, progress }: { status: string; progress?: number }): React.ReactElement {
  if (status === 'generating' || status === 'queued') {
    return (
      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
        Generating{progress !== undefined && progress > 0 ? ` ${progress}%` : '…'}
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs text-warn" title="Usable, with research gaps recorded">
        Partial research
      </span>
    );
  }
  if (status === 'failed') {
    return <span className="rounded-full bg-bad/10 px-2 py-0.5 text-xs text-bad">Failed</span>;
  }
  return <span className="rounded-full bg-good/10 px-2 py-0.5 text-xs text-good">Ready</span>;
}

function SkeletonList(): React.ReactElement {
  return (
    <ul className="space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-20 animate-pulse rounded-card border border-line bg-raised" />
      ))}
    </ul>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-card border border-bad/30 bg-bad/5 p-6 text-center" role="alert">
      <p className="text-ink">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink"
      >
        Try again
      </button>
    </div>
  );
}
