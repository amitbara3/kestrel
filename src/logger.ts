/**
 * Structured JSON logging, no dependency.
 *
 * One line of JSON per event so a log shipper can parse it without a regex.
 * Redaction is applied to every field name that has ever been a leak (Rules.md
 * §5) — it runs on the serialised object, not at each call site, because a call
 * site is exactly where someone forgets.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const REDACT_KEYS = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'x-api-key',
  'databaseurl',
  'database_url',
  'redisurl',
  'redis_url',
  'connectionstring',
]);

/** Keep a recognisable prefix so a key can be correlated in support without exposing it. */
function maskSecret(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? maskSecret(v) : '***';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  /** Injected so tests can capture output instead of writing to the console. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const threshold = LEVEL_RANK[level];

  function emit(lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_RANK[lvl] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...bindings,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // A circular field must never take down a request. Fall back to the message.
      sink(JSON.stringify({ ts: record.ts, level: lvl, msg, note: 'fields-unserialisable' }));
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) =>
      createLogger({
        ...(options.sink ? { sink: options.sink } : {}),
        level,
        bindings: { ...bindings, ...extra },
      }),
  };
}

/** Discards everything. Used by tests that assert on behaviour, not on logs. */
export const nullLogger: Logger = createLogger({ level: 'silent', sink: () => {} });
