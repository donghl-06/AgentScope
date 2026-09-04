export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogContext = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: LogContext;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const SENSITIVE_KEY =
  /(api[-_]?key|authorization|cookie|password|prompt|secret|token|env(?:ironment)?)/i;
const REDACTED = '[REDACTED]';

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(nestedValue);
    }
    return result;
  }

  return value;
}

export function createConsoleLogger(minimumLevel: LogLevel = 'info'): Logger {
  const minimumIndex = LOG_LEVELS.indexOf(minimumLevel);

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LOG_LEVELS.indexOf(level) < minimumIndex) {
      return;
    }

    const record: LogRecord = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context === undefined ? {} : { context: redactSensitive(context) as LogContext }),
    };
    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}
