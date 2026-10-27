import {describe, expect, it} from 'vitest';

import {
    coerce,
    decodeStatus,
    encodeCommand,
    enumId,
    extract,
    formatKeys,
    isOptimistic,
    mergeJson,
    numericIn,
    numericOut,
    parsePath,
    shape,
    wrap,
} from '../src/engine/payload.ts';
import {CommandHalfSchema, StatusHalfSchema} from '../src/model/schema.ts';

const status = (half: Record<string, unknown>) => StatusHalfSchema.parse({topic: 't', ...half});
const command = (half: Record<string, unknown>) => CommandHalfSchema.parse({topic: 'c', ...half});

describe('parsePath', () => {
    it.each([
        ['$', []],
        ['', []],
        ['$.POWER', ['POWER']],
        ['POWER', ['POWER']],
        ['$.a.b', ['a', 'b']],
        ['a.b.c', ['a', 'b', 'c']],
        ['$.a[0].b', ['a', 0, 'b']],
        ['$[0]', [0]],
        ['a["x y"].z', ['a', 'x y', 'z']],
        ["$['k'][2]", ['k', 2]],
    ])('%s → %j', (path, expected) => {
        expect(parsePath(path)).toEqual(expected);
    });

    it('rejects a malformed path', () => {
        expect(() => parsePath('$.a[')).toThrow(/invalid JSON path/);
    });
});

describe('extract and wrap', () => {
    const doc = {POWER: 'ON', state: {on: true, list: [1, {x: 2}]}};
    it.each([
        [[], doc],
        [['POWER'], 'ON'],
        [['state', 'on'], true],
        [['state', 'list', 1, 'x'], 2],
        [['state', 'missing'], undefined],
        [['POWER', 'deeper'], undefined],
        [['state', 'list', 'notAnIndex'], undefined],
    ])('extract %j', (path, expected) => {
        expect(extract(doc, path)).toEqual(expected);
    });

    it('wraps a value into the path', () => {
        expect(wrap(['a', 'b'], 1)).toEqual({a: {b: 1}});
        expect(wrap(['list', 0], 'x')).toEqual({list: ['x']});
        expect(wrap([], 7)).toBe(7);
        expect(extract(wrap(parsePath('$.color.x'), 0.3), parsePath('color.x'))).toBe(0.3);
    });
});

describe('coerce — explicit, no guessing', () => {
    it.each([
        ['boolean', true, true],
        ['boolean', 'true', true],
        ['boolean', 'false', false],
        ['boolean', 'ON', undefined],
        ['boolean', '1', undefined],
        ['boolean', 1, undefined],
        ['number', 42, 42],
        ['number', '42.5', 42.5],
        ['number', ' 7 ', 7],
        ['number', 'abc', undefined],
        ['number', '', undefined],
        ['number', Number.NaN, undefined],
        ['string', 'x', 'x'],
        ['string', 3, '3'],
        ['string', false, 'false'],
        ['string', {a: 1}, undefined],
    ] as const)('%s(%j) = %j', (type, value, expected) => {
        expect(coerce(value, type)).toEqual(expected);
    });
});

describe('decodeStatus: extract, map, type', () => {
    it('maps a raw payload', () => {
        const half = status({map: {ON: true, OFF: false}});
        expect(decodeStatus(half, Buffer.from('ON'))).toEqual({ok: true, value: true});
        expect(decodeStatus(half, 'OFF')).toEqual({ok: true, value: false});
        expect(decodeStatus(half, 'TOGGLE')).toEqual({ok: false, reason: expect.stringContaining('not in the map')});
    });

    it("maps to null, and reads a template's None as null: a value only for a nullable attribute", () => {
        const nullable = {metatype: 'integer' as const, nullable: true};
        const percent = status({map: {auto: null, '1': 10}});
        expect(decodeStatus(percent, 'auto', nullable)).toEqual({ok: true, value: null});
        expect(decodeStatus(percent, '1', nullable)).toEqual({ok: true, value: 10});
        const none = status({template: "{{ value_json.x | default('None') }}", type: 'number'});
        expect(decodeStatus(none, '{}', nullable)).toEqual({ok: true, value: null});
        expect(decodeStatus(none, '{"x": 5}', nullable)).toEqual({ok: true, value: 5});
        expect(decodeStatus(none, '{}', {metatype: 'enum'})).toEqual({
            ok: false,
            reason: 'null, but the attribute is not nullable',
            absent: true,
        });
        // a map that names None keeps it
        expect(decodeStatus(status({template: '{{ value }}', map: {None: 'x'}}), 'None')).toEqual({
            ok: true,
            value: 'x',
        });
    });

    it('falls back to `default` for an unmapped value', () => {
        const half = status({map: {heat: 'heat'}, default: ''});
        expect(decodeStatus(half, 'idle')).toEqual({ok: true, value: ''});
    });

    it('extracts from JSON, then maps', () => {
        const half = status({extract: '$.POWER', map: {ON: true, OFF: false}});
        expect(decodeStatus(half, '{"POWER":"ON","Dimmer":50}')).toEqual({ok: true, value: true});
        expect(decodeStatus(half, '{"Dimmer":50}')).toEqual({
            ok: false,
            reason: expect.stringContaining('not in payload'),
            absent: true,
        });
        expect(decodeStatus(half, 'not json')).toEqual({ok: false, reason: expect.stringContaining('not JSON')});
    });

    it('extracts with an explicit type', () => {
        expect(decodeStatus(status({extract: 'Dimmer', type: 'number'}), '{"Dimmer":"50"}')).toEqual({
            ok: true,
            value: 50,
        });
        expect(decodeStatus(status({extract: 'on', type: 'boolean'}), '{"on":true}')).toEqual({ok: true, value: true});
        expect(decodeStatus(status({extract: 'on', type: 'boolean'}), '{"on":"ON"}')).toEqual({
            ok: false,
            reason: expect.stringContaining('not a boolean'),
        });
    });

    it('takes a plain payload as text and a JSON scalar as itself', () => {
        expect(decodeStatus(status({}), 'hello')).toEqual({ok: true, value: 'hello'});
        expect(decodeStatus(status({type: 'number'}), '21.5')).toEqual({ok: true, value: 21.5});
        expect(decodeStatus(status({extract: '$'}), '42')).toEqual({ok: true, value: 42});
        expect(decodeStatus(status({}), 'null')).toEqual({ok: true, value: null});
    });

    it('hands objects and arrays through for the families', () => {
        expect(decodeStatus(status({extract: 'color'}), '{"color":{"x":0.3,"y":0.4}}')).toEqual({
            ok: true,
            value: {x: 0.3, y: 0.4},
        });
        expect(decodeStatus(status({extract: '$'}), '{"a":1}')).toEqual({ok: true, value: {a: 1}});
    });

    it('maps booleans and numbers by their text form', () => {
        expect(decodeStatus(status({extract: 'on', map: {true: 1, false: 0}}), '{"on":false}')).toEqual({
            ok: true,
            value: 0,
        });
    });
});

describe('decodeStatus: templates', () => {
    it('renders value and value_json', () => {
        // Jinja binds filters tighter than `*`: (temperature | float) * (100 | round(0)) = 2150.0, as Home Assistant renders it
        expect(
            decodeStatus(
                status({template: '{{ value_json.temperature | float * 100 | round(0) }}'}),
                '{"temperature":21.5}',
            ),
        ).toEqual({
            ok: true,
            value: '2150.0',
        });
        expect(
            decodeStatus(
                status({template: '{{ (value_json.temperature | float * 100) | round(0) }}', type: 'number'}),
                '{"temperature":21.5}',
            ),
        ).toEqual({
            ok: true,
            value: 2150,
        });
        expect(decodeStatus(status({template: '{{ value | upper }}', map: {ON: true, OFF: false}}), 'on')).toEqual({
            ok: true,
            value: true,
        });
        expect(decodeStatus(status({extract: 'a', template: '{{ value * 2 }}', type: 'number'}), '{"a":21}')).toEqual({
            ok: true,
            value: 42,
        });
    });

    it('reports an empty render and a failing template', () => {
        expect(decodeStatus(status({template: '{{ value_json.missing | default("") }}'}), '{}')).toEqual({
            ok: false,
            reason: expect.stringContaining('empty'),
            absent: true,
        });
        expect(decodeStatus(status({template: '{{ value | is_defined }}'}), '')).toEqual({
            ok: false,
            reason: expect.stringContaining('template'),
            absent: true,
        });
    });
});

describe('numeric steps', () => {
    it('unit, scale, offset, invert, round in order (status) and inverted (command)', () => {
        const half = status({unit: 'celsius', round: 0});
        expect(numericIn(21.456, half)).toBe(2146);
        expect(numericOut(2146, command({unit: 'celsius', round: 1}))).toBe(21.5);

        const brightness = status({scale: {from: [0, 100], to: [1, 254]}, round: 0});
        expect(numericIn(0, brightness)).toBe(1);
        expect(numericIn(100, brightness)).toBe(254);
        expect(numericIn(50, brightness)).toBe(128);
        expect(numericIn(150, brightness)).toBe(254);
        expect(numericOut(254, command({scale: {from: [0, 100], to: [1, 254]}, round: 0}))).toBe(100);

        const cover = status({scale: {from: [0, 100], to: [10000, 0]}});
        expect(numericIn(100, cover)).toBe(0);
        expect(numericIn(0, cover)).toBe(10000);
        expect(numericOut(2500, command({scale: {from: [0, 100], to: [10000, 0]}}))).toBe(75);

        const inverted = status({scale: {from: [0, 100], to: [0, 10000]}, invert: true});
        expect(numericIn(100, inverted)).toBe(0);
        expect(numericOut(0, command({scale: {from: [0, 100], to: [0, 10000]}, invert: true}))).toBe(100);

        expect(numericIn(10, status({offset: 5}))).toBe(15);
        expect(numericOut(15, command({offset: 5}))).toBe(10);
        expect(numericIn(2.345, status({round: 2}))).toBe(2.35);
    });

    it('does not clamp when told not to', () => {
        expect(numericIn(150, status({scale: {from: [0, 100], to: [0, 10], clamp: false}}))).toBe(15);
    });

    it('inverts booleans', () => {
        expect(decodeStatus(status({type: 'boolean', invert: true}), 'true')).toEqual({ok: true, value: false});
        expect(encodeCommand(command({invert: true}), true).payload).toBe('false');
    });
});

describe('shape: the attribute decides', () => {
    const members = new Map([
        ['Off', 0],
        ['Heat', 4],
        ['Cool', 3],
    ]);
    it('rounds integers, keeps floats, refuses the wrong kind', () => {
        expect(shape(2.6, {metatype: 'integer'})).toEqual({ok: true, value: 3});
        expect(shape(2.6, {metatype: 'float'})).toEqual({ok: true, value: 2.6});
        expect(shape('x', {metatype: 'integer'})).toEqual({ok: false, reason: 'not a number'});
        expect(shape(1, {metatype: 'boolean'})).toEqual({ok: false, reason: 'not a boolean'});
    });

    it('handles null by nullability', () => {
        expect(shape(null, {metatype: 'integer', nullable: true})).toEqual({ok: true, value: null});
        // null is "no value": logged at debug, not a failure
        expect(shape(null, {metatype: 'integer', nullable: false})).toEqual({
            ok: false,
            reason: expect.stringContaining('null'),
            absent: true,
        });
    });

    it('resolves enum names and bitmap fields', () => {
        expect(shape('Heat', {metatype: 'enum', enumMembers: members})).toEqual({ok: true, value: 4});
        expect(shape('heat', {metatype: 'enum', enumMembers: members})).toEqual({ok: true, value: 4});
        expect(shape('4', {metatype: 'enum', enumMembers: members})).toEqual({ok: true, value: 4});
        expect(shape('Warm', {metatype: 'enum', enumMembers: members})).toEqual({
            ok: false,
            reason: expect.stringContaining('not one of'),
        });
        const fields = [
            {name: 'heat', bit: 0},
            {name: 'cool', bit: 1},
            {name: 'fan', bit: 2},
        ];
        expect(shape('heat,fan', {metatype: 'bitmap', bitFields: fields})).toEqual({
            ok: true,
            value: {heat: true, fan: true},
        });
        expect(shape('', {metatype: 'bitmap', bitFields: fields})).toEqual({ok: true, value: {}});
        expect(shape(true, {metatype: 'bitmap', bitFields: fields})).toEqual({ok: true, value: {heat: true}});
        expect(shape(5, {metatype: 'bitmap', bitFields: fields})).toEqual({
            ok: true,
            value: {heat: true, cool: false, fan: true},
        });
        expect(shape('warm', {metatype: 'bitmap', bitFields: fields})).toEqual({
            ok: false,
            reason: expect.stringContaining('not one of'),
        });
    });

    it('enumId accepts names, lower case and ids', () => {
        expect(enumId('Cool', members)).toBe(3);
        expect(enumId('cool', members)).toBe(3);
        expect(enumId('3', members)).toBe(3);
        expect(enumId('7', members)).toBeUndefined();
    });

    it('decodeStatus applies the shape at the end', () => {
        expect(
            decodeStatus(status({extract: 'mode', map: {heat: 'Heat', off: 'Off'}}), '{"mode":"heat"}', {
                metatype: 'enum',
                enumMembers: members,
            }),
        ).toEqual({
            ok: true,
            value: 4,
        });
        expect(
            decodeStatus(status({extract: 'level', unit: 'byteLevel'}), '{"level":128}', {metatype: 'integer'}),
        ).toEqual({ok: true, value: 127});
    });
});

describe('encodeCommand', () => {
    it('formats through the map, falls back to the text form', () => {
        const half = command({format: {true: 'ON', false: 'OFF'}});
        expect(encodeCommand(half, true).payload).toBe('ON');
        expect(encodeCommand(half, false).payload).toBe('OFF');
        expect(encodeCommand(half, 7).payload).toBe('7');
        expect(encodeCommand(command({}), 12.5).payload).toBe('12.5');
        expect(encodeCommand(command({precision: 1}), 12).payload).toBe('12.0');
    });

    it('keys the format map by enum names and bitmap fields', () => {
        const members = new Map([
            ['Locked', 1],
            ['Unlocked', 2],
        ]);
        expect(
            encodeCommand(command({format: {Locked: 'LOCK', Unlocked: 'UNLOCK'}}), 1, {
                target: {metatype: 'enum', enumMembers: members},
            }).payload,
        ).toBe('LOCK');
        expect(
            encodeCommand(command({format: {'1': 'LOCK'}}), 1, {target: {metatype: 'enum', enumMembers: members}})
                .payload,
        ).toBe('LOCK');
        expect(formatKeys({heat: true, fan: true, cool: false}, {metatype: 'bitmap'})).toEqual([
            'heat,fan',
            'heat',
            'fan',
        ]);
        expect(formatKeys({heat: true}, {metatype: 'bitmap'})).toEqual(['heat']);
    });

    it('renders templates with the value and the fields', () => {
        expect(
            encodeCommand(command({template: '{{ value }},{{ transition | default(0) }}'}), 128, {
                fields: {transition: 1.5},
            }).payload,
        ).toBe('128,1.5');
        expect(
            encodeCommand(
                command({template: '{{ hue }},{{ saturation }},100'}),
                {hue: 120, saturation: 50},
                {fields: {hue: 120, saturation: 50}},
            ).payload,
        ).toBe('120,50,100');
        expect(
            encodeCommand(command({template: '{{ name | lower }}'}), 4, {
                target: {metatype: 'enum', enumMembers: new Map([['Heat', 4]])},
            }).payload,
        ).toBe('heat');
    });

    it('wraps into JSON and reports the JSON for coalescing', () => {
        const half = command({wrap: 'state', format: {true: 'ON', false: 'OFF'}});
        expect(encodeCommand(half, true)).toEqual({payload: '{"state":"ON"}', json: {state: 'ON'}});
        expect(encodeCommand(command({wrap: '$.color'}), {x: 0.3, y: 0.4})).toEqual({
            payload: '{"color":{"x":0.3,"y":0.4}}',
            json: {color: {x: 0.3, y: 0.4}},
        });
        expect(encodeCommand(command({wrap: 'brightness', unit: 'byteLevel', round: 0}), 254)).toEqual({
            payload: '{"brightness":255}',
            json: {brightness: 255},
        });
    });

    it('publishes a fixed payload and objects as JSON', () => {
        expect(encodeCommand(command({payload: 'STOP'}), 'stop').payload).toBe('STOP');
        expect(encodeCommand(command({wrap: 'state', payload: 'STOP'}), 'stop')).toEqual({
            payload: '{"state":"STOP"}',
            json: {state: 'STOP'},
        });
        expect(encodeCommand(command({}), {hue: 1, saturation: 2})).toEqual({
            payload: '{"hue":1,"saturation":2}',
            json: {hue: 1, saturation: 2},
        });
    });

    it('runs the numeric steps out, not for enums', () => {
        expect(encodeCommand(command({unit: 'celsius', round: 1}), 2150).payload).toBe('21.5');
        expect(encodeCommand(command({scale: {from: [0, 100], to: [10000, 0]}, round: 0}), 2500).payload).toBe('75');
        expect(
            encodeCommand(command({unit: 'celsius'}), 4, {
                target: {metatype: 'enum', enumMembers: new Map([['Heat', 4]])},
            }).payload,
        ).toBe('4');
    });

    it('uses a codec when one is given', () => {
        const encoded = encodeCommand(command({codec: {module: 'x'}}), 3, {codec: (value) => ({v: value})});
        expect(encoded).toEqual({payload: '{"v":3}', json: {v: 3}});
        expect(decodeStatus(status({codec: {module: 'x'}}), 'abc', undefined, {codec: (text) => text.length})).toEqual({
            ok: true,
            value: 3,
        });
    });
});

describe('isOptimistic and mergeJson', () => {
    const c = command({});
    it('defaults to optimistic without a status half', () => {
        expect(isOptimistic({command: c})).toBe(true);
        expect(isOptimistic({status: status({}), command: c})).toBe(false);
        expect(isOptimistic({status: status({}), command: {...c, optimistic: true}})).toBe(true);
        expect(isOptimistic({command: {...c, optimistic: false}})).toBe(false);
    });

    it('deep-merges objects, later wins', () => {
        expect(mergeJson({state: 'ON'}, {brightness: 3})).toEqual({state: 'ON', brightness: 3});
        expect(mergeJson({color: {x: 1}}, {color: {y: 2}})).toEqual({color: {x: 1, y: 2}});
        expect(mergeJson({a: 1}, {a: 2})).toEqual({a: 2});
        expect(mergeJson({a: 1}, 'x')).toBe('x');
    });
});
