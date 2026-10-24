import {describe, expect, it} from 'vitest';

import {coerce, decodeStatus, encodeCommand, extract, isOptimistic, parsePath} from '../src/engine/payload.ts';

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

describe('extract', () => {
    const doc = {POWER: 'ON', state: {on: true, list: [1, {x: 2}]}};
    it.each([
        [[], doc],
        [['POWER'], 'ON'],
        [['state', 'on'], true],
        [['state', 'list', 1, 'x'], 2],
        [['state', 'missing'], undefined],
        [['POWER', 'deeper'], undefined],
        [['state', 'list', 'notAnIndex'], undefined],
    ])('%j', (path, expected) => {
        expect(extract(doc, path)).toEqual(expected);
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

describe('decodeStatus', () => {
    it('maps a raw payload', () => {
        const half = {topic: 't', map: {ON: true, OFF: false}};
        expect(decodeStatus(half, Buffer.from('ON'))).toEqual({ok: true, value: true});
        expect(decodeStatus(half, 'OFF')).toEqual({ok: true, value: false});
        expect(decodeStatus(half, 'TOGGLE')).toEqual({ok: false, reason: expect.stringContaining('not in the map')});
    });

    it('extracts from JSON, then maps', () => {
        const half = {topic: 't', extract: '$.POWER', map: {ON: true, OFF: false}};
        expect(decodeStatus(half, '{"POWER":"ON","Dimmer":50}')).toEqual({ok: true, value: true});
        expect(decodeStatus(half, '{"Dimmer":50}')).toEqual({
            ok: false,
            reason: expect.stringContaining('not in payload'),
        });
        expect(decodeStatus(half, 'not json')).toEqual({ok: false, reason: expect.stringContaining('not JSON')});
    });

    it('extracts with an explicit type', () => {
        expect(decodeStatus({topic: 't', extract: 'Dimmer', type: 'number'}, '{"Dimmer":"50"}')).toEqual({
            ok: true,
            value: 50,
        });
        expect(decodeStatus({topic: 't', extract: 'on', type: 'boolean'}, '{"on":true}')).toEqual({
            ok: true,
            value: true,
        });
        expect(decodeStatus({topic: 't', extract: 'on', type: 'boolean'}, '{"on":"ON"}')).toEqual({
            ok: false,
            reason: expect.stringContaining('not a boolean'),
        });
    });

    it('takes a plain payload as text and a JSON scalar as itself', () => {
        expect(decodeStatus({topic: 't'}, 'hello')).toEqual({ok: true, value: 'hello'});
        expect(decodeStatus({topic: 't', type: 'number'}, '21.5')).toEqual({ok: true, value: 21.5});
        expect(decodeStatus({topic: 't', extract: '$'}, '42')).toEqual({ok: true, value: 42});
        expect(decodeStatus({topic: 't', extract: '$'}, '{"a":1}')).toEqual({
            ok: false,
            reason: expect.stringContaining('not a scalar'),
        });
    });

    it('maps booleans and numbers by their text form', () => {
        expect(decodeStatus({topic: 't', extract: 'on', map: {true: 1, false: 0}}, '{"on":false}')).toEqual({
            ok: true,
            value: 0,
        });
    });
});

describe('encodeCommand', () => {
    it('formats through the map, falls back to the text form', () => {
        const half = {topic: 'c', format: {true: 'ON', false: 'OFF'}, retain: false, qos: 0 as const};
        expect(encodeCommand(half, true)).toBe('ON');
        expect(encodeCommand(half, false)).toBe('OFF');
        expect(encodeCommand(half, 7)).toBe('7');
        expect(encodeCommand({topic: 'c', retain: false, qos: 0}, 12.5)).toBe('12.5');
    });
});

describe('isOptimistic', () => {
    const command = {topic: 'c', retain: false, qos: 0 as const};
    it('defaults to optimistic without a status half', () => {
        expect(isOptimistic({command})).toBe(true);
        expect(isOptimistic({status: {topic: 's'}, command})).toBe(false);
        expect(isOptimistic({status: {topic: 's'}, command: {...command, optimistic: true}})).toBe(true);
        expect(isOptimistic({command: {...command, optimistic: false}})).toBe(false);
    });
});
