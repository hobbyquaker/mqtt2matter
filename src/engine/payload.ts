/* The payload engine: every conversion step in both directions, as pure functions over the
   model's halves. Status (device → Matter): extract (a JSON path) → template → map (or an explicit
   type; no guessing) → unit → scale → offset → invert → round → the attribute's shape (enum names to
   ids, bitmap names to flags, integers rounded). Command (Matter → device): the numeric steps inverted →
   format map → template → wrap, or a fixed payload. A codec, when a half has one, replaces its chain;
   the runtime loads the module and hands the functions in. The engine knows nothing of MQTT or
   matter.js; the attribute's shape comes in as a small description from the model's catalogue. */

import type {Metatype} from '../model/catalog.ts';
import type {CommandHalf, Scalar, StatusHalf, ValueType} from '../model/schema.ts';
import {renderTemplate} from './template.ts';
import {fromMatter, toMatter} from './units.ts';

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

/** `{a: {b: value}}` for the path `a.b`; an empty path is the value itself */
export function wrap(path: readonly (string | number)[], value: unknown): unknown {
    if (path.length === 0) {
        return value;
    }
    let result: unknown = value;
    for (let i = path.length - 1; i >= 0; i--) {
        const segment = path[i];
        if (segment === undefined) {
            continue;
        }
        if (typeof segment === 'number') {
            const array: unknown[] = [];
            array[segment] = result;
            result = array;
        } else {
            result = {[segment]: result};
        }
    }
    return result;
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

/** what the engine knows about the attribute it decodes for, from the model's catalogue */
export interface TargetShape {
    metatype?: Metatype | undefined;
    nullable?: boolean | undefined;
    /** enum member ids by name */
    enumMembers?: ReadonlyMap<string, number> | undefined;
    /** bitmap field names (lower camel) with their bit */
    bitFields?: readonly {name: string; bit: number}[] | undefined;
}

/** a decoded value: a scalar, null for a nullable attribute, or an object for composites and bitmaps */
export type Decoded = Scalar | null | Record<string, unknown> | unknown[];

/**
 * `absent`: the message carries no value for this half — the extract path is missing or the template rendered
 * nothing. Normal on a topic several mappings share (Tasmota's `RESULT`, a partial JSON report), so the runtime
 * logs it at debug rather than as a failure.
 */
export type DecodeResult = {ok: true; value: Decoded} | {ok: false; reason: string; absent?: true};

export type Decoder = (payload: string, context: {topic: string; options: unknown}) => unknown;
export type Encoder = (
    value: unknown,
    context: {topic: string; options: unknown; fields: Record<string, unknown>},
) => unknown;

export interface DecodeOptions {
    /** extra template variables (the runtime passes `topic`) */
    variables?: Record<string, unknown> | undefined;
    /** the loaded codec of the half, when it has one */
    codec?: Decoder | undefined;
    topic?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/** linear mapping with optional clamp; reversed `to` bounds invert */
function applyScale(value: number, scale: NonNullable<StatusHalf['scale']>, inverse: boolean): number {
    const [from, to] = inverse ? [scale.to, scale.from] : [scale.from, scale.to];
    const [a0, a1] = from;
    const [b0, b1] = to;
    let v = value;
    if (scale.clamp) {
        const lo = Math.min(a0, a1);
        const hi = Math.max(a0, a1);
        v = Math.min(hi, Math.max(lo, v));
    }
    if (a1 === a0) {
        return b0;
    }
    return b0 + ((v - a0) * (b1 - b0)) / (a1 - a0);
}

function mirror(value: number, range: readonly [number, number]): number {
    return range[0] + range[1] - value;
}

function roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/** the numeric steps of a status half, in order */
export function numericIn(value: number, half: StatusHalf): number {
    let v = value;
    if (half.unit !== undefined) {
        v = toMatter(half.unit, v);
    }
    if (half.scale !== undefined) {
        v = applyScale(v, half.scale, false);
    }
    if (half.offset !== undefined) {
        v += half.offset;
    }
    if (half.invert === true && half.scale !== undefined) {
        v = mirror(v, half.scale.to);
    }
    if (half.round !== undefined) {
        v = roundTo(v, half.round);
    }
    return v;
}

/** the numeric steps of a command half: the status order inverted */
export function numericOut(value: number, half: CommandHalf): number {
    let v = value;
    if (half.invert === true && half.scale !== undefined) {
        v = mirror(v, half.scale.to);
    }
    if (half.offset !== undefined) {
        v -= half.offset;
    }
    if (half.scale !== undefined) {
        v = applyScale(v, half.scale, true);
    }
    if (half.unit !== undefined) {
        v = fromMatter(half.unit, v);
    }
    if (half.round !== undefined) {
        v = roundTo(v, half.round);
    }
    return v;
}

/** a decoded value into the attribute's shape: enum names → ids, bitmap names/booleans → flags, integers rounded */
export function shape(value: Decoded, target: TargetShape | undefined): DecodeResult {
    if (target === undefined) {
        return {ok: true, value};
    }
    if (value === null) {
        return target.nullable === true
            ? {ok: true, value: null}
            : {ok: false, reason: 'null, but the attribute is not nullable'};
    }
    switch (target.metatype) {
        case 'boolean':
            return typeof value === 'boolean' ? {ok: true, value} : {ok: false, reason: 'not a boolean'};
        case 'integer':
            return typeof value === 'number'
                ? {ok: true, value: Math.round(value)}
                : {ok: false, reason: 'not a number'};
        case 'float':
            return typeof value === 'number' ? {ok: true, value} : {ok: false, reason: 'not a number'};
        case 'string':
            return typeof value === 'string' ? {ok: true, value} : {ok: false, reason: 'not a string'};
        case 'enum': {
            if (typeof value === 'number') {
                return {ok: true, value: Math.round(value)};
            }
            if (typeof value === 'string' && target.enumMembers !== undefined) {
                const id = enumId(value, target.enumMembers);
                if (id !== undefined) {
                    return {ok: true, value: id};
                }
                return {ok: false, reason: `"${value}" is not one of ${[...target.enumMembers.keys()].join(', ')}`};
            }
            return {ok: false, reason: 'not an enum value'};
        }
        case 'bitmap': {
            const fields = target.bitFields ?? [];
            if (isRecord(value)) {
                return {ok: true, value};
            }
            if (typeof value === 'boolean') {
                const first = fields[0];
                if (first === undefined) {
                    return {ok: false, reason: 'the bitmap has no fields'};
                }
                return {ok: true, value: {[first.name]: value}};
            }
            if (typeof value === 'number') {
                const flags: Record<string, boolean> = {};
                for (const field of fields) {
                    flags[field.name] = (Math.round(value) & (1 << field.bit)) !== 0;
                }
                return {ok: true, value: flags};
            }
            if (typeof value === 'string') {
                const flags: Record<string, boolean> = {};
                const names = value
                    .split(/[,\s|]+/)
                    .map((n) => n.trim())
                    .filter((n) => n !== '');
                for (const name of names) {
                    const field = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
                    if (field === undefined) {
                        return {ok: false, reason: `"${name}" is not one of ${fields.map((f) => f.name).join(', ')}`};
                    }
                    flags[field.name] = true;
                }
                return {ok: true, value: flags};
            }
            return {ok: false, reason: 'not a bitmap value'};
        }
        default:
            return {ok: true, value};
    }
}

/** an enum member id by name, case-insensitive, also accepting the id as text */
export function enumId(name: string, members: ReadonlyMap<string, number>): number | undefined {
    const direct = members.get(name);
    if (direct !== undefined) {
        return direct;
    }
    const lower = name.toLowerCase().replace(/[\s_-]/g, '');
    for (const [member, id] of members) {
        if (member.toLowerCase() === lower) {
            return id;
        }
    }
    if (/^\d+$/.test(name)) {
        const id = Number(name);
        for (const member of members.values()) {
            if (member === id) {
                return id;
            }
        }
    }
    return undefined;
}

/** an enum member name by id */
export function enumName(id: number, members: ReadonlyMap<string, number>): string | undefined {
    for (const [name, memberId] of members) {
        if (memberId === id) {
            return name;
        }
    }
    return undefined;
}

/**
 * Device → Matter: payload → attribute value through the status half's steps. A payload the half
 * cannot turn into a value is reported, not guessed.
 */
export function decodeStatus(
    half: StatusHalf,
    payload: Buffer | string,
    target?: TargetShape,
    options: DecodeOptions = {},
): DecodeResult {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    const topic = options.topic ?? half.topic;
    if (options.codec !== undefined) {
        try {
            const decoded = options.codec(text, {topic, options: half.codec?.options});
            if (decoded === undefined) {
                return {ok: false, reason: 'the codec returned undefined'};
            }
            return shape(decoded as Decoded, target);
        } catch (error) {
            return {ok: false, reason: `codec: ${(error as Error).message}`};
        }
    }
    let value: unknown = text;
    let json: unknown;
    if (half.extract !== undefined) {
        json = tryJson(text);
        if (json === undefined) {
            return {ok: false, reason: `payload is not JSON, cannot extract "${half.extract}"`};
        }
        value = extract(json, parsePath(half.extract));
        if (value === undefined) {
            return {ok: false, reason: `"${half.extract}" not in payload`, absent: true};
        }
    }
    if (half.template !== undefined) {
        json ??= tryJson(text);
        const rendered = renderTemplate(half.template, {
            ...options.variables,
            topic,
            value,
            value_json: json,
        });
        if (!rendered.ok) {
            return rendered;
        }
        if (rendered.text === '') {
            return {ok: false, reason: 'the template rendered an empty string', absent: true};
        }
        value = rendered.text;
    }
    if (half.map !== undefined) {
        const key = keyOf(value);
        const mapped = key === undefined ? undefined : half.map[key];
        if (mapped === undefined) {
            if (half.default !== undefined) {
                return finish(half.default);
            }
            return {ok: false, reason: `value ${JSON.stringify(value)} is not in the map`};
        }
        return finish(mapped);
    }
    if (half.type !== undefined) {
        const coerced = coerce(value, half.type);
        if (coerced === undefined) {
            if (half.default !== undefined) {
                return finish(half.default);
            }
            return {ok: false, reason: `value ${JSON.stringify(value)} is not a ${half.type}`};
        }
        return finish(coerced);
    }
    if (value === null) {
        return finish(null);
    }
    if (typeof value === 'string') {
        // a plain payload without extract: a JSON scalar is itself, anything else text
        if (half.extract === undefined && half.template === undefined) {
            const parsed = tryJson(value);
            if (parsed === null || typeof parsed === 'number' || typeof parsed === 'boolean') {
                return finish(parsed);
            }
        }
        return finish(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return finish(value);
    }
    if (isRecord(value) || Array.isArray(value)) {
        // composites (colour objects, arrays) are the families' business
        return finish(value as Decoded);
    }
    return {ok: false, reason: `value ${JSON.stringify(value)} is not a scalar; set "extract", "type" or "map"`};

    function finish(v: Decoded): DecodeResult {
        let out: Decoded = v;
        if (typeof out === 'number') {
            out = numericIn(out, half);
        } else if (typeof out === 'boolean' && half.invert === true) {
            out = !out;
        }
        return shape(out, target);
    }
}

export interface EncodeOptions {
    /** the attribute's shape, for enum ids → names in `format` keys and templates */
    target?: TargetShape | undefined;
    /** extra template variables the family adds (`brightness`, `transition`, `hue` …) */
    fields?: Record<string, unknown> | undefined;
    codec?: Encoder | undefined;
}

export interface Encoded {
    /** the payload text */
    payload: string;
    /** the payload as JSON when it is one and `wrap` built it — what `coalesce` merges */
    json: unknown;
}

function numberText(value: number, half: CommandHalf): string {
    if (half.precision !== undefined) {
        return value.toFixed(half.precision);
    }
    return String(Number.isInteger(value) ? value : Math.round(value * 1e6) / 1e6);
}

/** the text form of a Matter value a `format` map is keyed by: enum names, bitmap field lists, scalars */
export function formatKeys(value: unknown, target: TargetShape | undefined): string[] {
    if (typeof value === 'number' && target?.enumMembers !== undefined) {
        const name = enumName(value, target.enumMembers);
        return name === undefined ? [String(value)] : [name, String(value)];
    }
    if (isRecord(value) && target?.metatype === 'bitmap') {
        const names = Object.entries(value)
            .filter(([, on]) => on === true)
            .map(([name]) => name);
        return [names.join(','), ...(names.length === 1 ? [] : names)];
    }
    const key = keyOf(value);
    return key === undefined ? [] : [key];
}

/** Matter → device: attribute value → payload through the command half's steps */
export function encodeCommand(half: CommandHalf, value: unknown, options: EncodeOptions = {}): Encoded {
    const target = options.target;
    if (options.codec !== undefined) {
        const out = options.codec(value, {
            topic: half.topic,
            options: half.codec?.options,
            fields: options.fields ?? {},
        });
        const payload = typeof out === 'string' ? out : JSON.stringify(out);
        return {payload, json: typeof out === 'string' ? undefined : out};
    }
    let v: unknown = value;
    if (typeof v === 'number' && target?.metatype !== 'enum') {
        v = numericOut(v, half);
    } else if (typeof v === 'boolean' && half.invert === true) {
        v = !v;
    }
    const fields: Record<string, unknown> = {...options.fields};
    if (typeof v === 'number' && target?.enumMembers !== undefined) {
        fields.name = enumName(v, target.enumMembers);
    }
    let out: unknown = v;
    if (half.payload !== undefined) {
        out = half.payload;
    } else if (half.format !== undefined) {
        const keys = formatKeys(v, target);
        const hit = keys.map((k) => half.format?.[k]).find((p) => p !== undefined);
        out = hit ?? defaultText(v);
    } else if (half.template !== undefined) {
        const rendered = renderTemplate(half.template, {...fields, value: v, topic: half.topic});
        if (!rendered.ok) {
            throw new Error(rendered.reason);
        }
        out = rendered.text;
    }
    if (half.wrap !== undefined) {
        const json = wrap(parsePath(half.wrap), out);
        return {payload: JSON.stringify(json), json};
    }
    if (typeof out === 'string') {
        return {payload: out, json: undefined};
    }
    if (isRecord(out) || Array.isArray(out)) {
        return {payload: JSON.stringify(out), json: out};
    }
    return {payload: defaultText(out), json: undefined};

    function defaultText(x: unknown): string {
        if (typeof x === 'number') {
            return numberText(x, half);
        }
        if (typeof x === 'string') {
            return x;
        }
        if (x === null || x === undefined) {
            return '';
        }
        if (typeof x === 'boolean') {
            return String(x);
        }
        return JSON.stringify(x);
    }
}

/** the default of `optimistic`: a mapping without a status half applies the command locally */
export function isOptimistic(mapping: {status?: StatusHalf | undefined; command: CommandHalf}): boolean {
    return mapping.command.optimistic ?? mapping.status === undefined;
}

/** deep-merge JSON objects, later wins; arrays and scalars are replaced */
export function mergeJson(base: unknown, next: unknown): unknown {
    if (isRecord(base) && isRecord(next)) {
        const result: Record<string, unknown> = {...base};
        for (const [key, value] of Object.entries(next)) {
            result[key] = mergeJson(result[key], value);
        }
        return result;
    }
    return next;
}
