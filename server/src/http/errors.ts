import type { Context } from 'hono';
import { ZodError } from 'zod';
import { EngineInvariantError, PlanError } from '../engine/index.ts';
import { ImportError } from '../calendar/ics.ts';
import { OAuthError } from '../auth/google.ts';
import { LimitError } from '../store/types.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in (or start a guest session) to continue.') => new HttpError(401, 'unauthenticated', message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function errorResponse(c: Context, e: unknown): Response {
  const requestId = c.get('requestId') as string | undefined;
  const body = (status: number, code: string, message: string, details?: unknown) =>
    c.json({ error: { code, message, ...(details !== undefined ? { details } : {}), ...(requestId ? { requestId } : {}) } } satisfies ErrorBody, status as 400);

  if (e instanceof HttpError) return body(e.status, e.code, e.message, e.details);
  if (e instanceof ZodError) {
    return body(
      400,
      'validation_error',
      'The request is not valid.',
      e.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (e instanceof PlanError) return body(422, e.code, e.message);
  if (e instanceof ImportError) return body(e.code === 'too_large' ? 413 : 422, e.code, e.message);
  if (e instanceof OAuthError) return body(400, e.code, e.message);
  if (e instanceof LimitError) return body(409, e.code, e.message);
  if (e instanceof SyntaxError) return body(400, 'invalid_json', 'The request body is not valid JSON.');
  if (e instanceof EngineInvariantError) {
    // A bug, not a user error. Never return a plan that failed validation; log details server-side only.
    console.error(`[${requestId}] ENGINE INVARIANT VIOLATED`, e.violations);
    return body(500, 'internal_invariant', 'The scheduler produced an invalid plan and it was discarded. Nothing was changed. Please report this.');
  }
  if (e instanceof RangeError) return body(400, 'invalid_value', e.message);
  console.error(`[${requestId}] unhandled error`, e);
  return body(500, 'internal_error', 'Something went wrong on our side.');
}
