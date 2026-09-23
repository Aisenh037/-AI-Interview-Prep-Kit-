/**
 * Cross-cutting HTTP concerns.
 *
 * One error envelope, produced in exactly one place. No route ever writes an
 * error response itself, which is what keeps the shape consistent enough for the
 * frontend to have a single handler for every failure.
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { env } from '../config/env.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      requestId?: string;
    }
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.details = args.details ?? null;
    this.retryable = args.retryable ?? false;
  }

  static unauthenticated(message = 'Sign in to continue.'): ApiError {
    return new ApiError({ status: 401, code: 'AUTH_REQUIRED', message });
  }

  /**
   * Another user's kit is reported as missing, not forbidden.
   * A 403 confirms the id exists, which makes ids enumerable.
   */
  static notFound(message = 'Not found.'): ApiError {
    return new ApiError({ status: 404, code: 'NOT_FOUND', message });
  }

  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError({ status: 409, code, message, details });
  }

  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError({ status: 400, code, message, details });
  }
}

export const requestId: RequestHandler = (req, _res, next) => {
  req.requestId = randomUUID();
  next();
};

/** Attach the signed-in user, or leave the request anonymous. */
export const attachUser: RequestHandler = (req, _res, next) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[env().COOKIE_NAME];
  if (typeof token === 'string' && token !== '') {
    try {
      const payload = jwt.verify(token, env().AUTH_JWT_SECRET) as { sub?: string };
      if (typeof payload.sub === 'string') req.userId = payload.sub;
    } catch {
      // An expired or tampered token is simply not a session. The client tells
      // the difference from the error code below.
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.userId === undefined) {
    const token = (req.cookies as Record<string, string> | undefined)?.[env().COOKIE_NAME];
    // Distinguishing these two lets the client re-authenticate in place and
    // replay a queued edit, instead of redirecting and losing the draft.
    next(
      typeof token === 'string' && token !== ''
        ? new ApiError({
            status: 401,
            code: 'AUTH_SESSION_EXPIRED',
            message: 'Your session expired. Sign in to continue.',
          })
        : ApiError.unauthenticated(),
    );
    return;
  }
  next();
};

/**
 * Defence in depth for CSRF.
 *
 * The session cookie is SameSite=Lax, so a browser will not attach it to a
 * cross-site state-changing request in the first place. This rejects anything
 * that arrives with a foreign Origin anyway.
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.get('origin');
  if (origin === undefined || origin === '') {
    next();
    return;
  }
  const allowed = env()
    .CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) {
    next(
      new ApiError({ status: 403, code: 'FORBIDDEN_ORIGIN', message: 'Request origin not allowed.' }),
    );
    return;
  }
  next();
};

export function validate<T>(schema: ZodType<T>, source: 'body' | 'query' = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(source === 'body' ? req.body : req.query);
    if (!result.success) {
      next(
        new ApiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          message: 'The request is not valid.',
          details: result.error.issues.map((i) => ({
            path: `${source}.${i.path.join('.')}`,
            message: i.message,
          })),
        }),
      );
      return;
    }
    if (source === 'body') req.body = result.data;
    next();
  };
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound('No such endpoint.'));
};

/** The only place an error response is written. */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError({
          status: 500,
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong on our side.',
        });

  if (apiError.status >= 500) {
    process.stderr.write(
      `[${req.requestId ?? '-'}] ${req.method} ${req.originalUrl} -> ${String(
        (error as Error)?.stack ?? error,
      )}\n`,
    );
  }

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      status: apiError.status,
      requestId: req.requestId ?? null,
      retryable: apiError.retryable,
      // Stacks are logged, never returned.
      details: apiError.details,
    },
  });
};

/** Wrap an async handler so a rejection reaches the error handler. */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Read a route parameter as a string.
 *
 * Express 5 types params as `string | string[]`, because a path can declare a
 * repeated segment. Ours never do, so this narrows once here instead of at
 * every call site.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw ApiError.badRequest('MISSING_PARAM', `Missing route parameter: ${name}`);
}
