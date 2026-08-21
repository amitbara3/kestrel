/**
 * The error taxonomy (Rules.md §3).
 *
 * Every thrown error carries a stable machine `code`, an HTTP `status`, and a
 * message that is safe to return to a caller. Anything sensitive — driver text,
 * SQL, connection strings — belongs in `cause`, which is logged and never
 * serialised to the client.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNSAFE_URL'
  | 'NOT_FOUND'
  | 'GONE'
  | 'ALIAS_TAKEN'
  | 'RESERVED_ALIAS'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNSAFE_URL: 422,
  NOT_FOUND: 404,
  GONE: 410,
  ALIAS_TAKEN: 409,
  RESERVED_ALIAS: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    // 5xx messages are replaced with a generic string before they reach a client;
    // 4xx messages are written to be shown.
    this.expose = this.status < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  static notFound(what = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }

  static gone(what = 'Resource'): AppError {
    return new AppError('GONE', `${what} has expired`);
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_FAILED', message, details ? { details } : {});
  }

  static internal(message: string, cause?: unknown): AppError {
    return new AppError('INTERNAL', message, { cause });
  }

  static unavailable(dependency: string, cause?: unknown): AppError {
    return new AppError('DEPENDENCY_UNAVAILABLE', `${dependency} is unavailable`, {
      details: { dependency },
      cause,
    });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** The one error envelope every non-2xx JSON response uses (Rules.md §3). */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function toEnvelope(err: unknown, requestId: string): ErrorEnvelope {
  if (isAppError(err)) {
    return {
      error: {
        code: err.code,
        message: err.expose ? err.message : 'Internal server error',
        requestId,
        ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
      },
    };
  }
  return { error: { code: 'INTERNAL', message: 'Internal server error', requestId } };
}

/**
 * Resolve an HTTP status from any thrown value.
 *
 * Fastify raises its own errors before a handler ever runs — malformed JSON,
 * a body over the limit — and carries the correct status on `statusCode`.
 * Ignoring it would report a client mistake as a server fault, which is both
 * wrong for the caller and noise in the 5xx alerting.
 */
export function statusOf(err: unknown): number {
  if (isAppError(err)) return err.status;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status <= 599) return status;
  return 500;
}
