/* Can the payload engine run a Home Assistant template? The engine renders Jinja through
   `@huggingface/jinja` with Home Assistant's filters added (docs/config.md, "Templates"); what it cannot
   do — `states()`, `now()`, `this`, the time and regex helpers, `int(base=…)`, macros — must not become a
   mapping that fails at runtime. The importer parses the template with the same library and walks the
   program: every filter, test, called function and free name has to be one the engine provides; a
   `*_template` that is not leaves its mapping unadopted, listed with the template. The names here mirror
   the engine's (test/ha-templates.test.ts checks that the two agree). */

import * as jinjaModule from '@huggingface/jinja';

/* the library's declaration files import without extensions, which the type-aware lint cannot resolve */
const jinja = jinjaModule as unknown as {
    tokenize(source: string, options: {lstrip_blocks: boolean; trim_blocks: boolean}): unknown;
    parse(tokens: unknown): unknown;
};

/** the filters the engine renders: the library's built-ins plus the Home Assistant ones it adds */
export const FILTERS = new Set([
    'abs',
    'bool',
    'capitalize',
    'default',
    'd',
    'dictsort',
    'first',
    'float',
    'iif',
    'indent',
    'int',
    'is_defined',
    'is_number',
    'items',
    'join',
    'last',
    'length',
    'list',
    'lower',
    'map',
    'max',
    'min',
    'multiply',
    'rejectattr',
    'replace',
    'reverse',
    'round',
    'safe',
    'selectattr',
    'sort',
    'string',
    'strip',
    'title',
    'tojson',
    'trim',
    'unique',
    'upper',
]);

/** the tests (`is …`) the library knows */
export const TESTS = new Set([
    'boolean',
    'callable',
    'defined',
    'eq',
    'equalto',
    'even',
    'false',
    'integer',
    'iterable',
    'lower',
    'mapping',
    'none',
    'number',
    'odd',
    'sequence',
    'string',
    'true',
    'undefined',
    'upper',
]);

/** the functions the engine provides as globals */
export const FUNCTIONS = new Set(['float', 'iif', 'int', 'is_number', 'max', 'min']);

/** the names every template sees */
const GLOBALS = new Set(['true', 'false', 'none', 'True', 'False', 'None', 'loop', 'topic']);

/** the variables of a status half's template */
export const STATUS_VARIABLES = new Set(['value', 'value_json']);

/** the variables of a command half's template: the value, an enum's member name, the families' fields */
export const COMMAND_VARIABLES = new Set([
    'value',
    'name',
    'level',
    'brightness',
    'percent',
    'transition',
    'hue',
    'saturation',
    'h',
    's',
    'x',
    'y',
    'red',
    'green',
    'blue',
    'r',
    'g',
    'b',
    'mireds',
    'kelvin',
    'position',
    'open',
    'percent100ths',
    'mode',
    'speed',
    'action',
]);

/** keyword arguments the engine's filters do not implement (a silent wrong result otherwise) */
const UNSUPPORTED_KEYWORDS: Record<string, string[]> = {int: ['base'], float: ['base']};

type Node = Record<string, unknown> & {type: string};

function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

function identifierName(node: unknown): string | undefined {
    return isNode(node) && node.type === 'Identifier' ? (node.value as string) : undefined;
}

class Walker {
    readonly problems: string[] = [];
    private readonly bound = new Set<string>();
    private readonly variables: ReadonlySet<string>;

    constructor(variables: ReadonlySet<string>) {
        this.variables = variables;
    }

    private problem(text: string): void {
        if (!this.problems.includes(text)) {
            this.problems.push(text);
        }
    }

    private bind(node: unknown): void {
        const name = identifierName(node);
        if (name !== undefined) {
            this.bound.add(name);
        } else if (isNode(node) && node.type === 'TupleLiteral') {
            for (const item of node.value as unknown[]) {
                this.bind(item);
            }
        }
    }

    walk(node: unknown): void {
        if (Array.isArray(node)) {
            for (const item of node) {
                this.walk(item);
            }
            return;
        }
        if (!isNode(node)) {
            return;
        }
        switch (node.type) {
            case 'Identifier': {
                const name = node.value as string;
                if (!this.variables.has(name) && !GLOBALS.has(name) && !this.bound.has(name) && !FUNCTIONS.has(name)) {
                    this.problem(`"${name}" is not available`);
                }
                return;
            }
            case 'FilterExpression': {
                this.walk(node.operand);
                this.checkFilter(node.filter);
                return;
            }
            case 'FilterStatement': {
                this.checkFilter(node.filter);
                this.walk(node.body);
                return;
            }
            case 'TestExpression': {
                this.walk(node.operand);
                const test = identifierName(node.test);
                if (test !== undefined && !TESTS.has(test)) {
                    this.problem(`the test "${test}" is not available`);
                }
                return;
            }
            case 'CallExpression': {
                const callee = node.callee;
                const name = identifierName(callee);
                if (name !== undefined) {
                    if (!FUNCTIONS.has(name) && !this.bound.has(name)) {
                        this.problem(`"${name}()" is not available`);
                    }
                } else {
                    // a method on a value (`value_json.get('x')`, `'a,b'.split(',')`): the library's business
                    this.walk(callee);
                }
                this.walk(node.args);
                return;
            }
            case 'MemberExpression': {
                this.walk(node.object);
                if (node.computed === true) {
                    this.walk(node.property);
                }
                return;
            }
            case 'Set': {
                this.walk(node.value);
                this.walk(node.body);
                this.bind(node.assignee);
                return;
            }
            case 'For': {
                this.walk(node.iterable);
                this.bind(node.loopvar);
                this.walk(node.body);
                this.walk(node.defaultBlock);
                return;
            }
            case 'Macro':
            case 'CallStatement': {
                this.problem('macros are not available');
                return;
            }
            case 'BinaryExpression': {
                // the operator is a token, not a name to look up
                this.walk(node.left);
                this.walk(node.right);
                return;
            }
            case 'UnaryExpression': {
                this.walk(node.argument);
                return;
            }
            case 'ObjectLiteral': {
                // the library renders dictionaries with string keys only
                const entries = node.value instanceof Map ? [...node.value.entries()] : [];
                for (const [key, value] of entries) {
                    if (isNode(key) && key.type !== 'StringLiteral') {
                        this.problem('a dictionary with non-string keys is not available');
                    }
                    this.walk(key);
                    this.walk(value);
                }
                return;
            }
            default: {
                for (const [key, value] of Object.entries(node)) {
                    if (key !== 'type') {
                        this.walk(value);
                    }
                }
            }
        }
    }

    private checkFilter(filter: unknown): void {
        let name = identifierName(filter);
        let args: unknown[] = [];
        if (name === undefined && isNode(filter) && filter.type === 'CallExpression') {
            name = identifierName(filter.callee);
            args = filter.args as unknown[];
        }
        if (name === undefined) {
            return;
        }
        if (!FILTERS.has(name)) {
            this.problem(`the filter "${name}" is not available`);
        }
        const unsupported = UNSUPPORTED_KEYWORDS[name];
        for (const arg of args) {
            if (isNode(arg) && arg.type === 'KeywordArgumentExpression') {
                const key = identifierName(arg.key);
                if (key !== undefined && unsupported?.includes(key) === true) {
                    this.problem(`"${name}(${key}=…)" is not available`);
                }
            }
            this.walk(arg);
        }
    }
}

export type TemplateCheck = {ok: true} | {ok: false; reason: string};

/** can the engine render this template with the variables of that side? */
export function checkTemplate(
    source: string,
    side: 'status' | 'command',
    extra: readonly string[] = [],
): TemplateCheck {
    let program: unknown;
    try {
        program = jinja.parse(jinja.tokenize(source, {lstrip_blocks: true, trim_blocks: true}));
    } catch (error) {
        return {ok: false, reason: `does not parse: ${(error as Error).message}`};
    }
    const variables = new Set([...(side === 'status' ? STATUS_VARIABLES : COMMAND_VARIABLES), ...extra]);
    const walker = new Walker(variables);
    walker.walk((program as Node).body);
    return walker.problems.length === 0 ? {ok: true} : {ok: false, reason: walker.problems.join('; ')};
}
