import {describe, expect, it} from 'vitest';

import {Template, TemplateError, renderTemplate} from '../src/engine/template.ts';

const render = (source: string, variables: Record<string, unknown> = {}): string =>
    new Template(source).render(variables);

describe('templates: Home Assistant in practice', () => {
    it.each([
        ['{{ value_json.temp }}', {value_json: {temp: 21.5}}, '21.5'],
        ['{{ value_json["a b"] | float * 2 }}', {value_json: {'a b': '1.5'}}, '3.0'],
        ['{{ (value | float) / 100 }}', {value: '2150'}, '21.5'],
        ['{{ value | int }}', {value: '42'}, '42'],
        ['{{ value | lower }}', {value: 'ON'}, 'on'],
        ['{{ value_json.state | upper }}', {value_json: {state: 'on'}}, 'ON'],
        ['{{ value | default("x") }}', {}, 'x'],
        ['{{ value_json.x | default(5) }}', {value_json: {}}, '5'],
        ['{{ "ON" if value_json.state == "on" else "OFF" }}', {value_json: {state: 'on'}}, 'ON'],
        ['{{ value_json.state is defined }}', {value_json: {state: 'on'}}, 'true'],
        ['{% if value > 1 %}big{% else %}small{% endif %}', {value: 2}, 'big'],
        ['{{ value_json.list[0] }}', {value_json: {list: [7]}}, '7'],
        ['{{ value|float(0) }}', {value: 'abc'}, '0'],
        ['{{ value_json.x is none }}', {value_json: {x: null}}, 'true'],
        ['{{ value | trim }}', {value: ' a '}, 'a'],
        ['{{ value | abs }}', {value: -1}, '1'],
        ['{{ value | string }}', {value: 1}, '1'],
    ])('%s', (source, variables, expected) => {
        expect(render(source, variables)).toBe(expected);
    });
});

describe('templates: the registered filters', () => {
    it.each([
        ['{{ value | float | round(1) }}', {value: '21.56'}, '21.6'],
        ['{{ value | round(1) }}', {value: 21.56}, '21.6'],
        ['{{ value | round }}', {value: 21.56}, '22'],
        ['{{ value | round(0, "floor") }}', {value: 21.56}, '21'],
        ['{{ value | round(0, "ceil") }}', {value: 21.26}, '22'],
        ['{{ value | round(1, default=0) }}', {value: 'x'}, '0'],
        ['{{ iif(value, "a", "b") }}', {value: true}, 'a'],
        ['{{ value | iif("yes", "no") }}', {value: 0}, 'no'],
        ['{{ value | iif("yes", "no", "none") }}', {value: null}, 'none'],
        ['{{ value | is_defined }}', {value: 1}, '1'],
        ['{{ value | bool }}', {value: 'ON'}, 'true'],
        ['{{ value | bool }}', {value: 0}, 'false'],
        ['{{ value | bool(false) }}', {value: 'maybe'}, 'false'],
        ['{{ value | multiply(100) | round }}', {value: '21.5'}, '2150'],
        ['{{ value | is_number }}', {value: '1.5'}, 'true'],
        ['{{ value | is_number }}', {value: 'x'}, 'false'],
        ['{{ max(1, 2) }} {{ [3, 4] | max }} {{ [3, 4] | min }}', {}, '2 4 3'],
        ['{{ value_json.x | default(5) | round(0) }}', {value_json: {}}, '5'],
        ['{{ (value_json.temperature | float) * 9 / 5 + 32 }}', {value_json: {temperature: 20}}, '68.0'],
        ['{{ brightness }},{{ transition | default(0) }}', {brightness: 254}, '254,0'],
        ['{{ value | int(0, 16) }}', {value: 'ff'}, '255'],
        ['{{ value[1:3] | int(base=16) }}', {value: '#A0B0C0'}, '160'],
        ['{{ value | int(-1, 16) }}', {value: 'xyz'}, '-1'],
        ['{{ value | int(0, 2) }}', {value: '101'}, '5'],
        ['{{ value | int }} {{ int("7.9") }}', {value: '42.5'}, '42 7'],
    ])('%s', (source, variables, expected) => {
        expect(render(source, variables)).toBe(expected);
    });

    it('reports what it cannot do, with the source', () => {
        expect(() => render('{{ value | is_defined }}', {})).toThrow(TemplateError);
        expect(() => render('{{ value | round }}', {value: 'x'})).toThrow(/not a number/);
        expect(() => new Template('{{ value ')).toThrow(TemplateError);
        expect(renderTemplate('{{ value | nosuchfilter }}', {value: 1})).toEqual({
            ok: false,
            reason: expect.stringContaining('nosuchfilter'),
        });
    });

    it('keeps the source verbatim', () => {
        const source = '{{ value_json["x"] | round(2) }}';
        expect(new Template(source).source).toBe(source);
    });
});
