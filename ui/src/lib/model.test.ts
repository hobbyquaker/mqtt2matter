import {describe, expect, it} from 'vitest';

import type {Device} from './api.ts';
import {debounce, jsonPaths, tryJson} from './format.ts';
import {
    bindingTarget,
    cleanBinding,
    cleanDevice,
    cleanHalf,
    clusterOf,
    emptyBinding,
    familiesFor,
    scalarOf,
    valueOf,
} from './model.ts';
import {hashFor, parseHash} from './router.svelte.ts';

describe('the model helpers', () => {
    it('reads a binding target', () => {
        expect(bindingTarget({attribute: 'OnOff.onOff'})).toEqual({kind: 'attribute', name: 'OnOff.onOff'});
        expect(bindingTarget({invoke: 'WindowCovering.stopMotion'})).toEqual({
            kind: 'invoke',
            name: 'WindowCovering.stopMotion',
        });
        expect(bindingTarget({event: 'Switch'})).toEqual({kind: 'event', name: 'Switch'});
        expect(clusterOf('LevelControl.currentLevel')).toBe('LevelControl');
        expect(emptyBinding({kind: 'invoke', name: 'Identify.identify'})).toEqual({invoke: 'Identify.identify'});
    });

    it('names the families by the clusters', () => {
        expect(familiesFor(['OnOff', 'LevelControl', 'PowerSource'])).toEqual(['light', 'powerSource']);
        expect(familiesFor(['TemperatureMeasurement'])).toEqual([]);
    });

    it('cleans a half of what the form left empty', () => {
        expect(
            cleanHalf({
                topic: 't',
                extract: '',
                template: undefined,
                map: {},
                round: Number.NaN,
                scale: {from: [0, Number.NaN], to: [0, 1]},
                get: {topic: '', payload: ''},
            }),
        ).toEqual({topic: 't'});
        expect(cleanHalf({topic: 't', scale: {from: [0, 100], to: [1, 254]}, get: {topic: 'g', payload: ''}})).toEqual({
            topic: 't',
            scale: {from: [0, 100], to: [1, 254]},
            get: {topic: 'g', payload: ''},
        });
        expect(cleanBinding({attribute: 'OnOff.onOff', comment: '', status: {topic: 's', extract: ''}})).toEqual({
            attribute: 'OnOff.onOff',
            status: {topic: 's'},
        });
    });

    it('cleans a device', () => {
        const device: Device = {
            name: 'X',
            vendor: '',
            enabled: true,
            source: {kind: 'manual'},
            availability: {mode: 'latest', topics: [{topic: '', online: 'online', offline: 'offline'}]},
            endpoints: [
                {
                    id: 'main',
                    deviceTypes: ['OnOffLight'],
                    bindings: [],
                    options: {},
                    coalesce: 0,
                    features: {},
                    attributes: {},
                },
            ],
        };
        expect(cleanDevice(device)).toEqual({
            name: 'X',
            enabled: true,
            source: {kind: 'manual'},
            endpoints: [{id: 'main', deviceTypes: ['OnOffLight'], bindings: [], options: {}, coalesce: 0}],
        });
    });

    it('types map values and preview values as written', () => {
        expect(scalarOf('true')).toBe(true);
        expect(scalarOf('12.5')).toBe(12.5);
        expect(scalarOf('ON')).toBe('ON');
        expect(scalarOf('')).toBe('');
        expect(valueOf('{"x": 1}')).toEqual({x: 1});
        expect(valueOf('Heat')).toBe('Heat');
        expect(valueOf(' 42 ')).toBe(42);
    });
});

describe('formatting', () => {
    it('lists the JSON paths of a payload', () => {
        expect(jsonPaths({state: 'ON', color: {x: 0.3, y: 0.3}, list: [1, 2], 'odd key': true})).toEqual([
            {path: '$.state', value: 'ON'},
            {path: '$.color.x', value: 0.3},
            {path: '$.color.y', value: 0.3},
            {path: '$.list[0]', value: 1},
            {path: '$.list[1]', value: 2},
            {path: '$["odd key"]', value: true},
        ]);
        expect(jsonPaths('text')).toEqual([]);
        expect(tryJson('nope')).toBeUndefined();
    });

    it('debounces', async () => {
        const calls: number[] = [];
        const fn = debounce((n: number) => calls.push(n), 10);
        fn(1);
        fn(2);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(calls).toEqual([2]);
    });
});

describe('the router', () => {
    it('parses and builds hashes', () => {
        expect(parseHash('')).toEqual({page: 'devices', rest: ''});
        expect(parseHash('#/bridges')).toEqual({page: 'bridges', rest: ''});
        expect(parseHash('#/devices/living%20room/lamp')).toEqual({page: 'devices', rest: 'living room/lamp'});
        expect(parseHash('#/nowhere/x')).toEqual({page: 'devices', rest: ''});
        expect(hashFor('devices', 'a b')).toBe('#/devices/a%20b');
        expect(hashFor('log')).toBe('#/log');
    });
});
