/**
 * The API client.
 *
 * Everything goes through the same-origin rewrite, so the session cookie stays
 * first-party and no CORS preflight happens on the happy path.
 *
 * The 401 handling matters more than it looks. The brief asks for "sensible
 * handling of expired or invalid sessions", and the naive version — redirect to
 * the login page — throws away whatever the user was typing. Instead an expired
 * session raises a typed error the editor catches, so the draft survives, the
 * user signs in where they are, and the queued write is replayed.
 */

const BASE = process.env['NEXT_PUBLIC_API_BASE_PATH'] ?? '/api/backend';

export interface ApiErrorShape {
  code: string;
  message: string;
  status: number;
  requestId: string | null;
  retryable: boolean;
  details: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.code = shape.code;
    this.status = shape.status;
    this.details = shape.details;
  }

  /** The session ended mid-session; the caller should re-auth rather than navigate. */
  get isSessionExpired(): boolean {
    return this.code === 'AUTH_SESSION_EXPIRED';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Someone else changed this first; the caller shows a conflict, not an error. */
  get isConflict(): boolean {
    return this.code === 'CONFLICT_STALE_VERSION';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // Offline or the server is waking up. Distinguished from an HTTP error so
    // the UI can say "still saving" rather than "failed".
    throw new ApiError({
      code: 'NETWORK',
      message: 'Could not reach the server.',
      status: 0,
      requestId: null,
      retryable: true,
      details: null,
    });
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const shape = (body as { error?: ApiErrorShape } | null)?.error;
    throw new ApiError(
      shape ?? {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
        status: response.status,
        requestId: null,
        retryable: response.status >= 500,
        details: null,
      },
    );
  }

  return (body as { data: T }).data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Shapes the UI works with
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export type ItemType = 'requirement' | 'question' | 'flashcard' | 'story';

export interface KitItemView {
  id: string;
  publicId: string;
  type: ItemType;
  listKey: string;
  rank: string;
  status: 'active' | 'deleted' | 'superseded';
  version: number;
  createdBy: 'ai' | 'user';
  lastEditedBy: 'ai' | 'user';
  editedFields: string[];
  pinned: boolean;
  movedByUser: boolean;
  introducedByRunId: string | null;
  data: Record<string, unknown>;
}

export interface RunStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'ok' | 'degraded' | 'failed';
}

export interface JobView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stalled';
  progress: number;
  steps: RunStep[];
  events: { type: string; message?: string; at: string }[];
  error: { code: string; message: string } | null;
  sectionKey: string | null;
  kitStatus?: string;
}

export interface KitDetail {
  id: string;
  title: string;
  status: 'queued' | 'generating' | 'partial' | 'ready' | 'failed';
  input: { jd: string; companyUrl: string; days: number };
  kit: import('@kit/shared').Kit | null;
  items: KitItemView[];
  research: {
    pagesFetched: number;
    hiringPageFound: boolean;
    hiringPageUrl: string | null;
    discussionFound: boolean;
    rationale: string[];
    attempts: { url: string; outcome: string; code?: string }[];
  } | null;
  warnings: string[];
  edited: { brief: string[]; role: string[] };
  pinnedDays: number[];
  job: JobView | null;
}

export interface KitSummary {
  id: string;
  title: string;
  status: KitDetail['status'];
  companyUrl: string;
  days: number;
  createdAt: string;
  warnings: string[];
  job: { id: string; progress: number } | null;
}

/**
 * A plain-English account of a gap, with its consequence.
 *
 * Saying only "no hiring page found" leaves the user to work out whether that
 * matters. Naming the consequence is the difference between a warning and
 * something useful.
 */
export const GAP_COPY: Record<string, { title: string; consequence: string }> = {
  NO_HIRING_PAGE_FOUND: {
    title: 'No hiring process published on their site',
    consequence:
      'Questions are based on the job description and what else we could read, so nothing here assumes a particular interview format.',
  },
  NO_PUBLIC_DISCUSSION_FOUND: {
    title: 'No public discussion of their interviews',
    consequence:
      'Nobody appears to have written up interviewing here, so company-fit questions lean on the posting rather than on reports.',
  },
  COMPANY_SITE_UNREACHABLE: {
    title: 'Their website could not be reached',
    consequence: 'This kit is built from the job description alone. The company brief is deliberately empty.',
  },
  NO_ABOUT_PAGE_FOUND: {
    title: 'No about page found',
    consequence: 'The company brief is shorter than usual because there was little to read.',
  },
  JD_TOO_SHORT: {
    title: 'The job description is very short',
    consequence:
      'Only what the posting actually states has been extracted. A thin posting produces a thin kit rather than invented requirements.',
  },
  ROBOTS_DISALLOWED: {
    title: 'Their robots.txt asked us not to crawl',
    consequence: 'We respected it, so parts of their site were not read.',
  },
  COVERAGE_INCOMPLETE: {
    title: 'A requirement could not be covered',
    consequence: 'It is listed in the coverage panel. You can add a question for it by hand.',
  },
  SCHEDULE_NO_MATERIAL: {
    title: 'There was too little to build a study plan from',
    consequence: 'The schedule says so rather than padding itself out.',
  },
};

export function describeWarning(code: string): { title: string; consequence: string } | null {
  const key = code.split(':')[0] ?? code;
  if (key.startsWith('SUSPECTED_PROMPT_INJECTION')) {
    return {
      title: 'Suspicious instructions were ignored',
      consequence:
        'A page we read tried to give the model instructions. It was excluded from the research and is not cited as a source.',
    };
  }
  return GAP_COPY[key] ?? null;
}
