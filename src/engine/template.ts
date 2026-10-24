/* Templates: @huggingface/jinja renders `value_template`-style Jinja (study §2.4, decision: the library,
   not an own evaluator). The library ships Jinja's core — expressions, `if`, loops, the filters `int`,
   `float`, `default`, `lower`, `upper`, `trim`, `abs`, `string`, `join`, `length`, `replace`, `tojson` and
   the tests `defined`, `none`, `number`, `string` — but no way to register filters. The Home Assistant
   filters it lacks (`round`, `is_defined`, `iif`, `multiply`, `bool`, `is_number`, `max`, `min`) are
   added by rewriting the parsed program: a filter expression whose name is one of ours becomes a call of
   a function the environment provides, with the operand as its first argument. The template string stays
   verbatim in the config; only the parsed form is rewritten. */

import * as jinjaModule from '@huggingface/jinja';

/* the library's declaration files import without extensions, which the type-aware lint cannot resolve;
   this is the surface we use, typed here */
interface JinjaEnvironment {
    set(name: string, value: unknown): unknown;
}
interface JinjaInterpreter {
    run(program: unknown): {value: unknown};
}
const jinja = jinjaModule as unknown as {
    tokenize(source: string, options: {lstrip_blocks: boolean; trim_blocks: boolean}): unknown;
    parse(tokens: unknown): unknown;
    Environment: new () => JinjaEnvironment;
    Interpreter: new (env: JinjaEnvironment) => JinjaInterpreter;
};

type Node = Record<string, unknown> & {type: string};

type Filter = (value: unknown, ...args: unknown[]) => unknown;

/** the library hands nested arguments (arrays, keyword maps) as its runtime values; back to plain data */
function unwrap(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(unwrap);
    }
    if (value instanceof Map) {
        return new Map([...value.entries()].map(([k, v]) => [k, unwrap(v)]));
    }
    if (value !== null && typeof value === 'object' && 'type' in value && 'value' in value) {
        return unwrap((value as {value: unknown}).value);
    }
    return value;
}

function kwargsOf(args: unknown[]): {positional: unknown[]; keywords: Map<string, unknown>} {
    const plain = args.map(unwrap);
    const last = plain.at(-1);
    if (last instanceof Map) {
        return {positional: plain.slice(0, -1), keywords: last as Map<string, unknown>};
    }
    return {positional: plain, keywords: new Map()};
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Home Assistant's `round(precision, method, default)`: half-up like Python's `round` for .5 on positives */
function round(value: unknown, ...rest: unknown[]): unknown {
    const {positional, keywords} = kwargsOf(rest);
    const n = toNumber(value);
    const precision = toNumber(positional[0] ?? keywords.get('precision')) ?? 0;
    const methodValue = positional[1] ?? keywords.get('method');
    const method = typeof methodValue === 'string' ? methodValue : 'common';
    const fallback = positional[2] ?? keywords.get('default');
    if (n === undefined) {
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error(`round: ${JSON.stringify(value)} is not a number`);
    }
    const factor = 10 ** precision;
    let result: number;
    switch (method) {
        case 'ceil':
            result = Math.ceil(n * factor) / factor;
            break;
        case 'floor':
            result = Math.floor(n * factor) / factor;
            break;
        case 'half':
            result = Math.round(n * 2) / 2;
            break;
        default:
            result = Math.round(n * factor) / factor;
    }
    return precision === 0 ? Math.trunc(result) : result;
}

const FILTERS: Record<string, Filter> = {
    round,
    is_defined: (value) => {
        if (value === undefined) {
            throw new Error('is_defined: the value is undefined');
        }
        return value;
    },
    iif: (value, ...rest) => {
        const {positional} = kwargsOf(rest);
        const [ifTrue = true, ifFalse = false, ifNone] = positional;
        if (value === null || value === undefined) {
            return ifNone ?? ifFalse;
        }
        const falsy = value === false || value === 0 || value === '';
        return falsy ? ifFalse : ifTrue;
    },
    multiply: (value, ...rest) => {
        const {positional, keywords} = kwargsOf(rest);
        const n = toNumber(value);
        const factor = toNumber(positional[0]);
        if (n === undefined || factor === undefined) {
            const fallback = positional[1] ?? keywords.get('default');
            if (fallback !== undefined) {
                return fallback;
            }
            throw new Error(`multiply: ${JSON.stringify(value)} is not a number`);
        }
        return n * factor;
    },
    bool: (value, ...rest) => {
        const {positional, keywords} = kwargsOf(rest);
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            if (['true', 'yes', 'on', 'enable', '1'].includes(text)) {
                return true;
            }
            if (['false', 'no', 'off', 'disable', '0'].includes(text)) {
                return false;
            }
        }
        const fallback = positional[0] ?? keywords.get('default');
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error(`bool: ${JSON.stringify(value)} is not a boolean`);
    },
    is_number: (value) => toNumber(value) !== undefined && typeof value !== 'boolean',
    max: (value, ...rest) => {
        const {positional} = kwargsOf(rest);
        const v = unwrap(value);
        const values = Array.isArray(v) ? v : [v, ...positional];
        return values.map(toNumber).reduce<number>((a, b) => (b !== undefined && b > a ? b : a), -Infinity);
    },
    min: (value, ...rest) => {
        const {positional} = kwargsOf(rest);
        const v = unwrap(value);
        const values = Array.isArray(v) ? v : [v, ...positional];
        return values.map(toNumber).reduce<number>((a, b) => (b !== undefined && b < a ? b : a), Infinity);
    },
};

const PREFIX = '__m2m_';

/** rewrite `x | round(2)` into `__m2m_round(x, 2)` for the filters the library does not know */
function rewrite(node: unknown): unknown {
    if (Array.isArray(node)) {
        return node.map(rewrite);
    }
    if (node === null || typeof node !== 'object') {
        return node;
    }
    const n = node as Node;
    for (const key of Object.keys(n)) {
        n[key] = rewrite(n[key]);
    }
    if (n.type === 'FilterExpression') {
        const filter = n.filter as Node;
        let name: string | undefined;
        let args: unknown[] = [];
        if (filter.type === 'Identifier') {
            name = filter.value as string;
        } else if (filter.type === 'CallExpression' && (filter.callee as Node).type === 'Identifier') {
            name = (filter.callee as Node).value as string;
            args = filter.args as unknown[];
        }
        if (name !== undefined && name in FILTERS) {
            return {
                type: 'CallExpression',
                callee: {type: 'Identifier', value: PREFIX + name},
                args: [n.operand, ...args],
            };
        }
    }
    return n;
}

export class TemplateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TemplateError';
    }
}

/** a parsed template; `render` is synchronous and pure over its variables */
export class Template {
    readonly source: string;
    private readonly program: unknown;

    constructor(source: string) {
        this.source = source;
        try {
            this.program = rewrite(jinja.parse(jinja.tokenize(source, {lstrip_blocks: true, trim_blocks: true})));
        } catch (error) {
            throw new TemplateError(`template "${source}": ${(error as Error).message}`);
        }
    }

    render(variables: Record<string, unknown>): string {
        const env = new jinja.Environment();
        env.set('true', true);
        env.set('false', false);
        env.set('none', null);
        env.set('True', true);
        env.set('False', false);
        env.set('None', null);
        env.set('iif', FILTERS.iif);
        env.set('float', (v: unknown, fallback?: unknown) => toNumber(v) ?? fallback ?? 0);
        env.set('int', (v: unknown, fallback?: unknown) => {
            const n = toNumber(v);
            return n === undefined ? (fallback ?? 0) : Math.trunc(n);
        });
        env.set('is_number', FILTERS.is_number);
        env.set('max', FILTERS.max);
        env.set('min', FILTERS.min);
        for (const [name, filter] of Object.entries(FILTERS)) {
            env.set(PREFIX + name, filter);
        }
        for (const [name, value] of Object.entries(variables)) {
            env.set(name, value);
        }
        try {
            const result = new jinja.Interpreter(env).run(this.program);
            return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        } catch (error) {
            throw new TemplateError(`template "${this.source}": ${(error as Error).message}`);
        }
    }
}

const cache = new Map<string, Template>();

/** parsed once per distinct source */
export function template(source: string): Template {
    let parsed = cache.get(source);
    if (parsed === undefined) {
        parsed = new Template(source);
        cache.set(source, parsed);
    }
    return parsed;
}

/** render with the error turned into a result */
export function renderTemplate(
    source: string,
    variables: Record<string, unknown>,
): {ok: true; text: string} | {ok: false; reason: string} {
    try {
        return {ok: true, text: template(source).render(variables)};
    } catch (error) {
        return {ok: false, reason: (error as Error).message};
    }
}
