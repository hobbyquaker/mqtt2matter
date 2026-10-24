/* The template check of the Home Assistant importer against the engine: what it accepts the engine
   renders, what it rejects the engine cannot do; the two name lists agree. */

import {describe, expect, it} from 'vitest';

import {renderTemplate} from '../src/engine/template.ts';
import {ha} from '../src/importers/index.ts';

const ok = (source: string, side: 'status' | 'command' = 'status', extra: string[] = []): boolean =>
    ha.checkTemplate(source, side, extra).ok;
const reason = (source: string, side: 'status' | 'command' = 'status'): string => {
    const result = ha.checkTemplate(source, side);
    return result.ok ? '' : result.reason;
};

describe('accepted templates render', () => {
    const cases: [string, Record<string, unknown>, string][] = [
        ['{{ value_json.POWER }}', {value_json: {POWER: 'ON'}}, 'ON'],
        ["{{ value_json['DS18B20'].Temperature }}", {value_json: {DS18B20: {Temperature: 21.5}}}, '21.5'],
        ["{{ 'OFF' if 'no error' in value else 'ON' }}", {value: 'no error'}, 'OFF'],
        ["{{ 'online' if (value | int(0)) >= 2 else 'offline' }}", {value: '2'}, 'online'],
        ["{{ value_json.state if value_json.state in ['on', 'off'] else 'off' }}", {value_json: {state: 'on'}}, 'on'],
        ["{{ {'off':0, '1':1}[value_json.mode] | default('None') }}", {value_json: {mode: '1'}}, '1'],
        ['{{ value | float | round(1) }}', {value: '21.44'}, '21.4'],
        ['{{ value_json.tempc | is_defined }}', {value_json: {tempc: 20}}, '20'],
        ['{{ (value_json.a == 1) | iif("yes", "no") }}', {value_json: {a: 1}}, 'yes'],
        ["{% set v = 'x' if value else 'y' %}{{ v | upper }}", {value: true}, 'X'],
        ['{% if value_json.on %}{"p":true}{% else %}{"p":false}{% endif %}', {value_json: {on: false}}, '{"p":false}'],
        ["{{ value_json.Color.split(',')[0:3] | join(',') }}", {value_json: {Color: '1,2,3,4'}}, '1,2,3'],
        ['{{ value_json.events[0].event }}', {value_json: {events: [{event: 'single'}]}}, 'single'],
    ];
    for (const [source, variables, expected] of cases) {
        it(source, () => {
            expect(ok(source)).toBe(true);
            expect(renderTemplate(source, variables)).toEqual({ok: true, text: expected});
        });
    }

    it('command templates see the value, the enum name and the families’ fields', () => {
        expect(ok('{"brightness": {{ value }}}', 'command')).toBe(true);
        expect(ok('{{ red }},{{ green }},{{ blue }}', 'command')).toBe(true);
        expect(ok('{% set position = open %}{"position": {{ position }}}', 'command')).toBe(true);
        expect(ok('pos,{{ position }}', 'command', ['position'])).toBe(true);
        expect(ok('{{ value_json.x }}', 'command')).toBe(false);
    });
});

describe('rejected templates name the reason', () => {
    it('functions, names and filters the engine does not have', () => {
        expect(reason("{{ states('sensor.x') }}")).toContain('"states()" is not available');
        expect(reason('{{ this.state }}')).toContain('"this" is not available');
        expect(reason('{{ now().hour }}')).toContain('"now()" is not available');
        expect(reason('{{ value | timestamp_custom("%H") }}')).toContain('the filter "timestamp_custom"');
        expect(reason('{{ value | regex_replace("a", "b") }}')).toContain('the filter "regex_replace"');
        expect(reason('{{ value is match }}')).toContain('the test "match"');
        expect(reason('{{ entity_id }}')).toContain('"entity_id" is not available');
    });

    it('what the library parses but renders wrong', () => {
        expect(reason('{{ value[1:3] | int(base=16) }}')).toContain('"int(base=…)"');
        expect(reason("{{ {0:'off', 1:'on'}[value] }}")).toContain('non-string keys');
        expect(reason('{% macro m() %}x{% endmacro %}{{ m() }}')).toContain('macros');
    });

    it('a template that does not parse', () => {
        expect(reason('{{ value')).toContain('does not parse');
    });

    it('bound names are fine', () => {
        expect(ok('{% for e in value_json.events %}{{ e.name }}{% endfor %}')).toBe(true);
        expect(ok('{% set x = value | int %}{{ x + 1 }}')).toBe(true);
        expect(ok('{{ loop.index }}')).toBe(true);
    });
});

describe('the lists agree with the engine', () => {
    it('every filter the check allows renders through the engine (or is rejected by it for its arguments only)', () => {
        for (const filter of ha.FILTERS) {
            const result = renderTemplate(`{{ value | ${filter} }}`, {value: 'ab'});
            // a filter the library does not know fails with "Unknown filter"
            expect(
                result.ok || !result.reason.includes('Unknown filter'),
                `${filter}: ${result.ok ? '' : result.reason}`,
            ).toBe(true);
        }
    });

    it('every test the check allows is known to the library', () => {
        for (const test of ha.TESTS) {
            const result = renderTemplate(`{{ value is ${test} }}`, {value: 'ab'});
            expect(
                result.ok || !result.reason.includes('Unknown test'),
                `${test}: ${result.ok ? '' : result.reason}`,
            ).toBe(true);
        }
    });

    it('every function the check allows is callable', () => {
        for (const fn of ha.FUNCTIONS) {
            const result = renderTemplate(`{{ ${fn}(1) }}`, {});
            expect(result.ok, `${fn}: ${result.ok ? '' : result.reason}`).toBe(true);
        }
    });
});
