'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api } from '@/lib/api';

function LoginForm(): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/kits';
  const expired = params.get('reason') === 'expired';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      router.push(next);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
      <p className="mt-1 text-sm text-muted">to your interview prep kits</p>

      {expired && (
        <p className="mt-4 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-ink" role="status">
          Your session expired. Sign in and you will be taken straight back — anything you were
          typing is still saved on this device.
        </p>
      )}

      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />

        {error !== null && (
          <p className="rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-accent-ink disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-muted">
        No account?{' '}
        <Link href="/register" className="text-accent underline underline-offset-2">
          Create one
        </Link>
      </p>
    </main>
  );
}

export function Field(props: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
}): React.ReactElement {
  return (
    <div>
      <label htmlFor={props.id} className="mb-1 block text-sm font-medium text-ink">
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        required={props.required}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ink"
        aria-describedby={props.hint === undefined ? undefined : `${props.id}-hint`}
      />
      {props.hint !== undefined && (
        <p id={`${props.id}-hint`} className="mt-1 text-xs text-muted">
          {props.hint}
        </p>
      )}
    </div>
  );
}

export default function LoginPage(): React.ReactElement {
  return (
    <Suspense fallback={<main className="p-6 text-muted">Loading…</main>}>
      <LoginForm />
    </Suspense>
  );
}
