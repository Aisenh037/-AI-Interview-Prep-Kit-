'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }): React.ReactElement {
  const router = useRouter();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            // Never retry an auth or validation failure: retrying a 401 just
            // produces four identical 401s and delays the real feedback.
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // An expired session is first handled in place — the editor keeps the draft
  // and raises this — and only then do we navigate, carrying a `next` so the
  // user comes straight back to what they were doing.
  useEffect(() => {
    const handler = (): void => {
      const next = encodeURIComponent(window.location.pathname);
      router.push(`/login?next=${next}&reason=expired`);
    };
    window.addEventListener('ipk:session-expired', handler);
    return () => window.removeEventListener('ipk:session-expired', handler);
  }, [router]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
