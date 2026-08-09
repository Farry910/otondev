import { redact } from '@otondev/contracts';
import type { Clock, Component } from '@otondev/contracts';

/**
 * Structured logging (W0-E).
 *
 * Contracts §1: "Logs redact/hide fields by schema, not only string matching." Two
 * consequences shape this module.
 *
 * First, there is no `log(message, ...args)` printf form. Every call takes a message and a
 * structured field object, because a redactor can only redact fields it can see — once a
 * value has been interpolated into a string it is gone.
 *
 * Second, redaction happens here rather than at the sink. A log line that reaches a
 * collector unredacted has already left the process, and every downstream copy of it is now
 * someone else's retention problem.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  ts: string;
  level: LogLevel;
  service: Component;
  msg: string;
  /** Correlation and trace context, when the caller has them. */
  correlation_id?: string;
  trace_id?: string;
  span_id?: string;
  fields: LogFields;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger with additional fields on every record. Used per-request, per-workflow. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  service: Component;
  clock: Clock;
  level?: LogLevel;
  /** Where records go. Defaults to one JSON object per line on stdout. */
  sink?: (record: LogRecord) => void;
  /** Fields attached to every record from this logger. */
  base?: LogFields;
}

export function jsonLineSink(write: (line: string) => void = (line) => process.stdout.write(line)): (
  record: LogRecord,
) => void {
  return (record) => write(`${JSON.stringify(record)}\n`);
}

/** Collects records in memory. The sink a test asserts against. */
export function memorySink(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? jsonLineSink();
  const base = options.base ?? {};

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] < minimum) return;
    const merged = { ...base, ...fields };
    // Redact before anything else touches the record. Correlation and trace ids are lifted
    // out because a log aggregator indexes them, and burying them in `fields` makes the one
    // query an incident actually needs impossible.
    const safe = redact(merged) as LogFields;
    const record: LogRecord = {
      ts: options.clock.nowIso(),
      level,
      service: options.service,
      msg,
      fields: omit(safe, ['correlation_id', 'trace_id', 'span_id']),
    };
    for (const key of ['correlation_id', 'trace_id', 'span_id'] as const) {
      const value = safe[key];
      if (typeof value === 'string') record[key] = value;
    }
    sink(record);
  };

  const logger: Logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) =>
      createLogger({
        service: options.service,
        clock: options.clock,
        ...(options.level === undefined ? {} : { level: options.level }),
        sink,
        base: { ...base, ...fields },
      }),
  };
  return logger;
}

function omit(fields: LogFields, keys: readonly string[]): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}
