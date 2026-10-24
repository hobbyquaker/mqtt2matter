/* The payload engine, phase 0: the steps the first device needs — extract (a JSON path), type (explicit,
   no guessing), map (value → value) on the way in; format (value → payload) on the way out. Pure functions
   over the model's halves; phase 1 adds scale, unit, wrap, templates, coalescing and the codec escape hatch. */

import type {CommandHalf, Scalar, StatusHalf, ValueType} from '../model/schema.ts';

/** `$.a.b[0]`, `a.b[0]`, `a.b.0` → ['a', 'b', 0]; `$` or '' → [] (the whole payload) */
export function parsePath(path: string): (string | number)[] {
    let rest = path.trim();
    if (rest === '$' || rest === '') {
        return [];
    }
    if (rest.startsWith('$.')) {
        rest = rest.slice(2);
    } else if (rest.startsWith('$[')) {
        rest = rest.slice(1);
    }
    const segments: (string | number)[] = [];
    const pattern = /([^.[\]]+)|\[(\d+)\]|\[(?:"([^"]*)"|'([^']*)')\]/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = pattern.exec(rest)) !== null) {
        if (match[2] !== undefined) {
            segments.push(Number(match[2]));
        } else {
            segments.push(match[1] ?? match[3] ?? match[4] ?? '');
        }
        consumed = pattern.lastIndex;
        if (rest[consumed] === '.') {
            pattern.lastIndex += 1;
            consumed += 1;
        }
    }
    if (consumed !== rest.length) {
        throw new Error(`invalid JSON path "${path}"`);
    }
    return segments;
}

/** the value at `path` in `value`, or undefined when a segment is missing */
export function extract(value: unknown, path: readonly (string | number)[]): unknown {
    let cursor: unknown = value;
    for (const segment of path) {
        if (cursor === null || typeof cursor !== 'object') {
            return undefined;
        }
        if (typeof segment === 'number') {
            if (!Array.isArray(cursor)) {
                return undefined;
            }
            cursor = cursor[segment];
        } else {
            cursor = (cursor as Record<string, unknown>)[segment];
        }
    }
    return cursor;
}

/** the explicit type conversions; nothing loose (`"1"` is not true, `"ON"` is not true) */
export function coerce(value: unknown, type: ValueType): Scalar | undefined {
    switch (type) {
        case 'boolean':
            if (typeof value === 'boolean') {
                return value;
            }
            if (value === 'true') {
                return true;
            }
            if (value === 'false') {
                return false;
            }
            return undefined;
        case 'number': {
            if (typeof value === 'number') {
                return Number.isFinite(value) ? value : undefined;
            }
            if (typeof value === 'string' && value.trim() !== '') {
                const n = Number(value);
                return Number.isFinite(n) ? n : undefined;
            }
            return undefined;
        }
        case 'string':
            if (typeof value === 'string') {
                return value;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            return undefined;
    }
}

/** a scalar as the text key used by `map` and `format` */
export function keyOf(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return undefined;
}

export type DecodeResult = {ok: true; value: Scalar} | {ok: false; reason: string};

/**
 * Device → Matter: payload → attribute value through the status half's steps. A payload the half
 * cannot turn into a value is reported, not guessed.
 */
export function decodeStatus(half: StatusHalf, payload: Buffer | string): DecodeResult {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    let value: unknown = text;
    if (half.extract !== undefined) {
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            return {ok: false, reason: `payload is not JSON, cannot extract "${half.extract}"`};
        }
        value = extract(json, parsePath(half.extract));
        if (value === undefined) {
            return {ok: false, reason: `"${half.extract}" not in payload`};
        }
    }
    if (half.map !== undefined) {
        const key = keyOf(value);
        const mapped = key === undefined ? undefined : half.map[key];
        if (mapped === undefined) {
            return {ok: false, reason: `value ${JSON.stringify(value)} is not in the map`};
        }
        return {ok: true, value: mapped};
    }
    if (half.type !== undefined) {
        const coerced = coerce(value, half.type);
        if (coerced === undefined) {
            return {ok: false, reason: `value ${JSON.stringify(value)} is not a ${half.type}`};
        }
        return {ok: true, value: coerced};
    }
    const key = keyOf(value);
    if (key === undefined) {
        return {ok: false, reason: `value ${JSON.stringify(value)} is not a scalar; set "extract", "type" or "map"`};
    }
    return {
        ok: true,
        value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : key,
    };
}

/** Matter → device: attribute value → payload text through the command half's steps */
export function encodeCommand(half: CommandHalf, value: Scalar): string {
    const key = String(value);
    if (half.format !== undefined) {
        return half.format[key] ?? key;
    }
    return key;
}

/** the default of `optimistic`: a binding without a status half applies the command locally */
export function isOptimistic(binding: {status?: StatusHalf | undefined; command: CommandHalf}): boolean {
    return binding.command.optimistic ?? binding.status === undefined;
}
