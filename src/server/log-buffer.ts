/* The last lines of the log, for the UI's log page and the event stream. A sink for the logger
   (src/log.ts): the application tees stderr and this buffer. The lines keep the logger's format
   (`<iso> <LEVEL> [<scope>] <message>`); the buffer splits them so the UI does not have to. */

import type {LogLevel, LogSink} from '../log.ts';

export interface LogEntry {
    id: number;
    ts: string;
    level: LogLevel;
    scope: string;
    message: string;
}

const LINE = /^(\S+) (DEBUG|INFO|WARN|ERROR)\s*(?:\[([^\]]*)\])? ?(.*)$/s;

export function parseLogLine(line: string, id: number): LogEntry {
    const match = LINE.exec(line);
    if (match === null) {
        return {id, ts: new Date().toISOString(), level: 'info', scope: '', message: line};
    }
    return {
        id,
        ts: match[1] ?? '',
        level: (match[2] ?? 'INFO').toLowerCase() as LogLevel,
        scope: match[3] ?? '',
        message: match[4] ?? '',
    };
}

export class LogBuffer {
    private readonly entries: LogEntry[] = [];
    private readonly limit: number;
    private readonly listeners = new Set<(entry: LogEntry) => void>();
    private next = 1;

    constructor(limit = 2000) {
        this.limit = limit;
    }

    /** the sink to hand to `createLogger` */
    get sink(): LogSink {
        return (line) => {
            this.push(line);
        };
    }

    push(line: string): LogEntry {
        const entry = parseLogLine(line, this.next++);
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries.splice(0, this.entries.length - this.limit);
        }
        for (const listener of this.listeners) {
            listener(entry);
        }
        return entry;
    }

    /** the newest `limit` entries, oldest first; `after` an id returns only newer ones */
    list(limit = 500, after = 0): LogEntry[] {
        const newer = after > 0 ? this.entries.filter((e) => e.id > after) : this.entries;
        return newer.slice(Math.max(0, newer.length - limit));
    }

    onEntry(listener: (entry: LogEntry) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}
