/**
 * Ephemeral editor state.
 *
 * Deliberately separate from the server cache. What the user has typed but not
 * yet saved is not server state, and treating it as such is how drafts get
 * thrown away by a refetch.
 *
 * The rule this store exists to enforce: A NETWORK FAILURE NEVER DISCARDS TEXT.
 * The usual optimistic-update pattern rolls back on error, which is right for a
 * reorder and catastrophic for a paragraph someone just wrote. Structure rolls
 * back; prose does not.
 */
import { create } from 'zustand';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'retrying' | 'offline' | 'conflict';

export interface Draft {
  itemId: string;
  field: string;
  text: string;
  baseVersion: number;
}

interface Conflict {
  mine: string;
  theirs: string;
  field: string;
}

interface EditorState {
  drafts: Record<string, Draft>;
  saving: Record<string, SaveState>;
  conflicts: Record<string, Conflict>;
  focusedItemId: string | null;
  newSinceRunId: string | null;

  setDraft(key: string, draft: Draft): void;
  clearDraft(key: string): void;
  setSaving(key: string, state: SaveState): void;
  setConflict(key: string, conflict: Conflict | null): void;
  setFocused(itemId: string | null): void;
  markNewRun(runId: string | null): void;
  isDirty(key: string): boolean;
}

const STORAGE_PREFIX = 'ipk:draft:';

/** Mirror unsent text to local storage so a refresh or crash cannot eat it. */
function persist(key: string, draft: Draft | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (draft === null) window.localStorage.removeItem(STORAGE_PREFIX + key);
    else window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
  } catch {
    // Private browsing, or storage is full. Losing the mirror is acceptable;
    // throwing here would break editing entirely.
  }
}

export function recoverDraft(key: string): Draft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as Draft);
  } catch {
    return null;
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  drafts: {},
  saving: {},
  conflicts: {},
  focusedItemId: null,
  newSinceRunId: null,

  setDraft: (key, draft) => {
    persist(key, draft);
    set((state) => ({
      drafts: { ...state.drafts, [key]: draft },
      saving: { ...state.saving, [key]: 'dirty' },
    }));
  },

  clearDraft: (key) => {
    persist(key, null);
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },

  setSaving: (key, value) => set((state) => ({ saving: { ...state.saving, [key]: value } })),

  setConflict: (key, conflict) =>
    set((state) => {
      const conflicts = { ...state.conflicts };
      if (conflict === null) delete conflicts[key];
      else conflicts[key] = conflict;
      return { conflicts, saving: { ...state.saving, [key]: conflict === null ? 'idle' : 'conflict' } };
    }),

  setFocused: (itemId) => set({ focusedItemId: itemId }),
  markNewRun: (runId) => set({ newSinceRunId: runId }),
  isDirty: (key) => get().drafts[key] !== undefined,
}));

export const draftKey = (itemId: string, field: string): string => `${itemId}:${field}`;
