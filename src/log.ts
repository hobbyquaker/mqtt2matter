/* A small leveled logger with scopes: `log.child('matter/default')` prefixes every line. One sink per
   process (stderr by default); matter.js keeps its own logger, whose level `config.log.matter` sets. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const ORDER: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

export type LogSink = (line: string) => void;

export interface Logger {
    readonly scope: string;
    child(scope: string): Logger;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

class ScopedLogger implements Logger {
    readonly scope: string;
    private readonly threshold: LogLevel;
    private readonly sink: LogSink;

    constructor(scope: string, threshold: LogLevel, sink: LogSink) {
        this.scope = scope;
        this.threshold = threshold;
        this.sink = sink;
    }

    child(scope: string): Logger {
        return new ScopedLogger(this.scope ? `${this.scope}/${scope}` : scope, this.threshold, this.sink);
    }

    debug(message: string): void {
        this.write('debug', message);
    }

    info(message: string): void {
        this.write('info', message);
    }

    warn(message: string): void {
        this.write('warn', message);
    }

    error(message: string, error?: unknown): void {
        this.write('error', error === undefined ? message : `${message}: ${describeError(error)}`);
    }

    private write(level: LogLevel, message: string): void {
        if (ORDER[level] < ORDER[this.threshold]) {
            return;
        }
        const scope = this.scope ? ` [${this.scope}]` : '';
        this.sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}${scope} ${message}`);
    }
}

/** the error's message, or its string form for anything that is not an Error */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
}

export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function createLogger(
    level: LogLevel,
    sink: LogSink = (line) => {
        console.error(line);
    },
): Logger {
    return new ScopedLogger('', level, sink);
}

/** a logger that drops everything (tests, library use without logging) */
export const silentLogger: Logger = createLogger('error', () => undefined);
