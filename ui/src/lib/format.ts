/* Small formatting helpers shared by the pages. */

export function formatTime(ts: number | string): string {
    const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return String(ts);
    }
    return date.toLocaleTimeString(undefined, {hour12: false});
}

export function formatDateTime(ts: number | string): string {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return String(ts);
    }
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, {hour12: false})}`;
}

/** a value for a table cell: JSON for objects, the text otherwise */
export function formatValue(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && !Number.isInteger(value)) {
        return String(Number(value.toFixed(6)));
    }
    return String(value);
}

/** parse JSON, undefined when it is not JSON */
export function tryJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** the JSON paths of a payload's scalar leaves, `$.a.b[0]` style, for the topic picker */
export function jsonPaths(value: unknown, prefix = '$'): {path: string; value: unknown}[] {
    if (isRecord(value)) {
        return Object.entries(value).flatMap(([key, v]) =>
            jsonPaths(v, /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${prefix}.${key}` : `${prefix}["${key}"]`),
        );
    }
    if (Array.isArray(value)) {
        return value.flatMap((v, index) => jsonPaths(v, `${prefix}[${index}]`));
    }
    return prefix === '$' ? [] : [{path: prefix, value}];
}

export function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? '';
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (...args) => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            fn(...args);
        }, ms);
    };
}

export function download(name: string, text: string): void {
    const blob = new Blob([text], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}
