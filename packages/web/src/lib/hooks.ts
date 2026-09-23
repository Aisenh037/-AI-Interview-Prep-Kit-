'use client';

/**
 * The data layer.
 *
 * The split that matters: mutations changing STRUCTURE (reorder, delete, pin)
 * are optimistic and roll back on failure, because snapping an item back to
 * where it was is the right answer. Mutations changing TEXT deliberately do not
 * roll back — the editor owns those, and deleting someone's paragraph because a
 * request timed out is the worst possible outcome.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type JobView, type KitDetail, type KitSummary, type SessionUser } from './api';

export const kitKeys = {
  all: ['kits'] as const,
  detail: (id: string) => ['kit', id] as const,
  job: (id: string) => ['kit', id, 'job'] as const,
  practice: (id: string) => ['kit', id, 'practice'] as const,
};

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/auth/me'),
    retry: false,
  });
}

export function useKits() {
  return useQuery({ queryKey: kitKeys.all, queryFn: () => api.get<KitSummary[]>('/kits') });
}

export function useKit(id: string) {
  return useQuery({
    queryKey: kitKeys.detail(id),
    queryFn: () => api.get<KitDetail>(`/kits/${id}`),
    // Poll while work is in flight. Polling rather than a stream is deliberate:
    // it survives the rewrite proxy and a cold start with no reconnection
    // logic, and the longest request stays well under a second.
    refetchInterval: (query) => {
      const data = query.state.data as KitDetail | undefined;
      if (data === undefined) return false;
      const busy =
        data.status === 'queued' ||
        data.status === 'generating' ||
        data.job?.status === 'running' ||
        data.job?.status === 'queued';
      return busy ? 1500 : false;
    },
  });
}

export function useJob(kitId: string, enabled: boolean) {
  return useQuery({
    queryKey: kitKeys.job(kitId),
    queryFn: () => api.get<JobView | null>(`/kits/${kitId}/job`),
    enabled,
    refetchInterval: enabled ? 1500 : false,
  });
}

/** Text edits. Called by the editor; never rolls back on failure. */
export function useItemPatch(kitId: string) {
  const client = useQueryClient();
  return async (
    publicId: string,
    patch: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<{ version: number }> => {
    const result = await api.patch<{
      publicId: string;
      version: number;
      data: Record<string, unknown>;
    }>(`/kits/${kitId}/items/${publicId}`, { patch, expectedVersion });

    client.setQueryData<KitDetail>(kitKeys.detail(kitId), (old) =>
      old === undefined
        ? old
        : {
            ...old,
            items: old.items.map((item) =>
              item.publicId === publicId
                ? { ...item, version: result.version, data: result.data, lastEditedBy: 'user' as const }
                : item,
            ),
          },
    );
    return { version: result.version };
  };
}

/** Structural mutations: optimistic, and rolled back if the server disagrees. */
export function useStructuralMutation(kitId: string) {
  const client = useQueryClient();

  const optimistic = <T,>(apply: (detail: KitDetail) => KitDetail, run: () => Promise<T>): Promise<T> => {
    const previous = client.getQueryData<KitDetail>(kitKeys.detail(kitId));
    if (previous !== undefined) client.setQueryData(kitKeys.detail(kitId), apply(previous));
    return run().catch((error: unknown) => {
      if (previous !== undefined) client.setQueryData(kitKeys.detail(kitId), previous);
      throw error;
    });
  };

  return {
    pin: (publicId: string, pinned: boolean) =>
      optimistic(
        (detail) => ({
          ...detail,
          items: detail.items.map((i) => (i.publicId === publicId ? { ...i, pinned } : i)),
        }),
        () => api.put(`/kits/${kitId}/items/${publicId}/pin`, { pinned }),
      ),

    remove: (publicId: string) =>
      optimistic(
        (detail) => ({
          ...detail,
          items: detail.items.map((i) =>
            i.publicId === publicId ? { ...i, status: 'deleted' as const } : i,
          ),
        }),
        () => api.delete(`/kits/${kitId}/items/${publicId}`),
      ),

    restore: (publicId: string) =>
      optimistic(
        (detail) => ({
          ...detail,
          items: detail.items.map((i) =>
            i.publicId === publicId ? { ...i, status: 'active' as const } : i,
          ),
        }),
        () => api.post(`/kits/${kitId}/items/${publicId}/restore`),
      ),

    move: (
      publicId: string,
      body: {
        targetCategory?: string;
        afterId?: string | null;
        beforeId?: string | null;
        expectedVersion: number;
      },
    ) =>
      api
        .post<{ rank: string; listKey: string; version: number }>(
          `/kits/${kitId}/items/${publicId}/move`,
          body,
        )
        .then((result) => {
          client.setQueryData<KitDetail>(kitKeys.detail(kitId), (old) =>
            old === undefined
              ? old
              : {
                  ...old,
                  items: old.items.map((i) =>
                    i.publicId === publicId
                      ? {
                          ...i,
                          rank: result.rank,
                          listKey: result.listKey,
                          version: result.version,
                          movedByUser: true,
                        }
                      : i,
                  ),
                },
          );
          return result;
        }),

    add: (type: 'question' | 'flashcard', category: string | undefined, data: Record<string, unknown>) =>
      api.post<{ publicId: string }>(`/kits/${kitId}/items`, { type, category, data }).then((r) => {
        void client.invalidateQueries({ queryKey: kitKeys.detail(kitId) });
        return r;
      }),

    regenerate: (sectionKey: string) =>
      api.post<{ jobId: string }>(`/kits/${kitId}/regenerate`, { sectionKey }).then((r) => {
        void client.invalidateQueries({ queryKey: kitKeys.detail(kitId) });
        return r;
      }),
  };
}

export function useCreateKit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { jd: string; companyUrl: string; days: number; force?: boolean }) =>
      api.post<{ kitId: string; duplicate: boolean; rescheduled?: boolean }>('/kits', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: kitKeys.all }),
  });
}
