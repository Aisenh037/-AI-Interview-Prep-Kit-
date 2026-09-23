'use client';

/**
 * Inline editing.
 *
 * One component owns draft state, debouncing, the save indicator, conflict
 * resolution and keyboard handling, so every editable field in the application
 * behaves identically and the hard part is solved once.
 *
 * Two behaviours are load-bearing:
 *
 *  - Keystrokes never round-trip. They go to a local draft; the flush is
 *    debounced, and also fires on blur, on Ctrl/Cmd+Enter and before unload.
 *  - A failed save NEVER discards what was typed. The usual optimistic pattern
 *    rolls back on error, which would delete the user's paragraph. Here the
 *    draft stays, the state goes amber, and it retries.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { draftKey, recoverDraft, useEditorStore, type SaveState } from '@/lib/editorStore';

const DEBOUNCE_MS = 600;

export interface EditableTextProps {
  itemId: string;
  field: string;
  value: string;
  version: number;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  className?: string;
  onCommit: (patch: Record<string, unknown>, expectedVersion: number) => Promise<{ version: number }>;
}

export function EditableText(props: EditableTextProps): React.ReactElement {
  const key = draftKey(props.itemId, props.field);
  const fieldId = useId();
  const store = useEditorStore();
  const draft = store.drafts[key];
  const saveState: SaveState = store.saving[key] ?? 'idle';
  const conflict = store.conflicts[key];

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(props.value);
  const [, force] = useState(0);

  // Recover anything a previous session left unsent.
  useEffect(() => {
    const recovered = recoverDraft(key);
    if (recovered !== null && recovered.text !== props.value) {
      store.setDraft(key, recovered);
      force((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = draft?.text ?? props.value;
  latest.current = shown;

  const flush = useCallback(
    async (text: string, baseVersion: number): Promise<void> => {
      if (text === props.value) {
        store.clearDraft(key);
        store.setSaving(key, 'idle');
        return;
      }
      store.setSaving(key, 'saving');
      try {
        const result = await props.onCommit({ [props.field]: text }, baseVersion);
        // Only clear the draft if the user has not typed more since the flush
        // began; otherwise a newer debounce is already pending.
        if (latest.current === text) {
          store.clearDraft(key);
          store.setSaving(key, 'saved');
          setTimeout(() => store.setSaving(key, 'idle'), 1500);
        } else {
          store.setDraft(key, {
            itemId: props.itemId,
            field: props.field,
            text: latest.current,
            baseVersion: result.version,
          });
        }
      } catch (error) {
        if (error instanceof ApiError && error.isConflict) {
          const current = (error.details as { current?: { data?: Record<string, string> } } | null)
            ?.current;
          store.setConflict(key, {
            mine: text,
            theirs: current?.data?.[props.field] ?? '',
            field: props.field,
          });
          return;
        }
        if (error instanceof ApiError && error.isSessionExpired) {
          // Do NOT navigate away: the draft is still here and the user can sign
          // in without losing it.
          store.setSaving(key, 'offline');
          window.dispatchEvent(new CustomEvent('ipk:session-expired'));
          return;
        }
        // Network or server error. Keep the text, say so, and try again.
        store.setSaving(key, 'retrying');
        setTimeout(() => void flush(latest.current, baseVersion), 4000);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.value, props.version, key],
  );

  const onChange = (text: string): void => {
    store.setDraft(key, {
      itemId: props.itemId,
      field: props.field,
      text,
      baseVersion: draft?.baseVersion ?? props.version,
    });
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush(text, draft?.baseVersion ?? props.version);
    }, DEBOUNCE_MS);
  };

  const flushNow = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (draft !== undefined) void flush(draft.text, draft.baseVersion);
  };

  // Nothing typed is lost to a navigation.
  useEffect(() => {
    const handler = (): void => flushNow();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  });

  if (conflict !== undefined) {
    return (
      <ConflictBanner
        mine={conflict.mine}
        theirs={conflict.theirs}
        onKeepMine={() => {
          store.setConflict(key, null);
          void flush(conflict.mine, props.version);
        }}
        onUseTheirs={() => {
          store.setConflict(key, null);
          store.clearDraft(key);
        }}
      />
    );
  }

  const Tag = props.multiline === false ? 'input' : 'textarea';

  return (
    <div className="group/edit relative">
      <label htmlFor={fieldId} className="sr-only">
        {props.label}
      </label>
      <Tag
        id={fieldId}
        rows={props.multiline === false ? undefined : 2}
        value={shown}
        readOnly={props.readOnly === true}
        placeholder={props.placeholder}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
          onChange(e.target.value)
        }
        onBlur={flushNow}
        onFocus={() => store.setFocused(props.itemId)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            flushNow();
            (e.target as HTMLElement).blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            store.clearDraft(key);
            store.setSaving(key, 'idle');
            (e.target as HTMLElement).blur();
          }
          // Let the list's shortcuts through only when not typing.
          e.stopPropagation();
        }}
        className={`autogrow w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-ink outline-none transition-colors hover:border-line focus:border-accent focus:bg-surface ${props.className ?? ''}`}
        aria-describedby={`${fieldId}-status`}
      />
      <span id={`${fieldId}-status`} className="sr-only">
        {saveStateLabel(saveState)}
      </span>
      <SaveIndicator state={saveState} onRetry={flushNow} />
    </div>
  );
}

function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving';
    case 'saved':
      return 'Saved';
    case 'retrying':
      return 'Save failed, retrying';
    case 'offline':
      return 'Not saved';
    case 'conflict':
      return 'Conflict';
    default:
      return '';
  }
}

/** Colour is never the only channel: every state carries a word or a shape. */
export function SaveIndicator({
  state,
  onRetry,
}: {
  state: SaveState;
  onRetry?: () => void;
}): React.ReactElement | null {
  if (state === 'idle') return null;

  const base = 'pointer-events-none absolute right-2 top-1.5 text-[11px] font-medium';
  if (state === 'dirty') return <span className={`${base} text-muted`} aria-hidden>•</span>;
  if (state === 'saving') return <span className={`${base} text-muted`}>Saving…</span>;
  if (state === 'saved') return <span className={`${base} text-good`}>Saved</span>;
  if (state === 'retrying') return <span className={`${base} text-warn`}>Retrying…</span>;
  if (state === 'offline') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="absolute right-2 top-1 rounded bg-bad/10 px-2 py-0.5 text-[11px] font-medium text-bad"
      >
        Not saved — retry
      </button>
    );
  }
  return null;
}

function ConflictBanner({
  mine,
  theirs,
  onKeepMine,
  onUseTheirs,
}: {
  mine: string;
  theirs: string;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-md border border-warn/40 bg-warn/5 p-3" role="alert">
      <p className="text-sm font-medium text-ink">
        This changed while you were editing it.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-line bg-surface p-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Yours</p>
          <p className="whitespace-pre-wrap text-sm text-ink">{mine}</p>
        </div>
        <div className="rounded border border-line bg-raised p-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">New version</p>
          <p className="whitespace-pre-wrap text-sm text-muted">{theirs || '(empty)'}</p>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onKeepMine}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
        >
          Keep mine
        </button>
        <button
          type="button"
          onClick={onUseTheirs}
          className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink"
        >
          Use the new one
        </button>
      </div>
    </div>
  );
}
