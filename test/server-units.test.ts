/* The server's pure parts: the compact file form round-trips, the adopt comparison, the log buffer,
   the router. */

import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {DeviceSchema} from '../src/model/schema.ts';
import {compactDevice} from '../src/server/compact.ts';
import {adoptEntries, deviceKeyFor, diff} from '../src/server/importers.ts';
import {LogBuffer, parseLogLine} from '../src/server/log-buffer.ts';
import {previewStatus} from '../src/server/preview.ts';

describe('compactDevice', () => {
    it('strips the defaults and parses back to the same device', () => {
        const raw = {
            name: 'Cover',
            enabled: true,
            availability: {topic: 'tele/c/LWT', online: 'Online', offline: 'Offline'},
            endpoints: [
                {
                    deviceTypes: ['WindowCovering'],
                    options: {cover: {echoFilter: true}},
                    coalesce: 100,
                    bindings: [
                        {
                            attribute: 'WindowCovering.currentPositionLiftPercent100ths',
                            status: {
                                topic: 'stat/c/pos',
                                scale: {from: [0, 100], to: [10000, 0]},
                                get: {topic: 'cmnd/c/get'},
                            },
                        },
                        {
                            attribute: 'WindowCovering.targetPositionLiftPercent100ths',
                            command: {topic: 'cmnd/c/pos', unit: 'percent100ths', retain: true, qos: 1},
                        },
                    ],
                },
                {id: 'battery', deviceTypes: ['PowerSource']},
            ],
        };
        const device = DeviceSchema.parse(raw);
        const compact = compactDevice(device);
        expect(compact).toEqual({
            name: 'Cover',
            availability: {topic: 'tele/c/LWT', online: 'Online', offline: 'Offline'},
            endpoints: [
                {
                    deviceTypes: ['WindowCovering'],
                    options: {cover: {echoFilter: true}},
                    coalesce: 100,
                    bindings: [
                        {
                            attribute: 'WindowCovering.currentPositionLiftPercent100ths',
                            status: {
                                topic: 'stat/c/pos',
                                scale: {from: [0, 100], to: [10000, 0]},
                                get: {topic: 'cmnd/c/get'},
                            },
                        },
                        {
                            attribute: 'WindowCovering.targetPositionLiftPercent100ths',
                            command: {topic: 'cmnd/c/pos', unit: 'percent100ths', retain: true, qos: 1},
                        },
                    ],
                },
                {id: 'battery', deviceTypes: ['PowerSource']},
            ],
        });
        expect(DeviceSchema.parse(compact)).toEqual(device);
    });

    it('keeps an orphaned source and a non-default availability mode', () => {
        const device = DeviceSchema.parse({
            name: 'X',
            enabled: false,
            source: {kind: 'z2m', key: '0x1', orphaned: true},
            availability: {mode: 'all', topics: [{topic: 'a'}, {topic: 'b', online: 'up', offline: 'down'}]},
            endpoints: [{deviceTypes: ['OnOffLight']}],
        });
        expect(compactDevice(device)).toEqual({
            name: 'X',
            enabled: false,
            source: {kind: 'z2m', key: '0x1', orphaned: true},
            availability: {mode: 'all', topics: [{topic: 'a'}, {topic: 'b', online: 'up', offline: 'down'}]},
            endpoints: [{deviceTypes: ['OnOffLight']}],
        });
    });
});

describe('adopt', () => {
    const generated = (key: string, topic: string) =>
        parseConfig({
            devices: {
                x: {
                    name: key,
                    source: {kind: 'z2m', key},
                    endpoints: [
                        {
                            deviceTypes: ['ContactSensor'],
                            bindings: [
                                {
                                    attribute: 'BooleanState.stateValue',
                                    status: {topic, extract: 'contact', type: 'boolean'},
                                },
                            ],
                        },
                    ],
                },
            },
        }).devices.x!;

    it('diffs JSON by path', () => {
        expect(diff({a: 1, b: [1, 2], c: {d: 'x'}}, {a: 1, b: [1, 3], c: {d: 'y', e: 1}})).toEqual([
            {path: 'b[1]', before: 2, after: 3},
            {path: 'c.d', before: 'x', after: 'y'},
            {path: 'c.e', before: undefined, after: 1},
        ]);
        expect(diff([1, 2], [1])).toEqual([{path: '', before: [1, 2], after: [1]}]);
    });

    it('derives device keys the pattern allows, without collisions', () => {
        expect(deviceKeyFor('Living room/lamp', new Set())).toBe('Living_room_lamp');
        expect(deviceKeyFor('0x00124b0022f1a2b3', new Set(['0x00124b0022f1a2b3']))).toBe('0x00124b0022f1a2b3_2');
        expect(deviceKeyFor('ßß', new Set())).toBe('device');
        expect(deviceKeyFor('a'.repeat(80), new Set(['a'.repeat(64)]))).toBe(`${'a'.repeat(62)}_2`);
    });

    it('classifies discovered devices against the configured ones', () => {
        const importer = {
            kind: 'z2m' as const,
            discovered: () => [
                {key: 'new', name: 'New', device: generated('new', 'z/new')},
                {key: 'same', name: 'Same', device: generated('same', 'z/same')},
                {key: 'moved', name: 'Moved', device: generated('moved', 'z/moved2')},
            ],
            resync: () => Promise.resolve(),
            onChange: () => () => undefined,
        };
        const devices = {
            same: {...generated('same', 'z/same'), bridge: 'b', enabled: false},
            moved: generated('moved', 'z/moved'),
            gone: generated('gone', 'z/gone'),
            manual: parseConfig({devices: {m: {name: 'Manual', endpoints: [{deviceTypes: ['OnOffLight']}]}}}).devices
                .m!,
        };
        const entries = adoptEntries(devices, [importer]);
        expect(entries.map((e) => [e.sourceKey, e.state, e.deviceKey])).toEqual([
            ['new', 'new', 'new'],
            ['same', 'adopted', 'same'],
            ['moved', 'changed', 'moved'],
            ['gone', 'orphaned', 'gone'],
        ]);
        expect(entries[2]?.changes).toEqual([
            {path: 'endpoints[0].bindings[0].status.topic', before: 'z/moved', after: 'z/moved2'},
        ]);
    });
});

describe('LogBuffer', () => {
    it('parses the logger format and keeps the newest lines', () => {
        expect(parseLogLine('2026-10-24T10:00:00.000Z WARN  [matter/default] hello [x]', 3)).toEqual({
            id: 3,
            ts: '2026-10-24T10:00:00.000Z',
            level: 'warn',
            scope: 'matter/default',
            message: 'hello [x]',
        });
        expect(parseLogLine('2026-10-24T10:00:00.000Z INFO  no scope', 4)).toMatchObject({
            level: 'info',
            scope: '',
            message: 'no scope',
        });
        expect(parseLogLine('garbage', 5)).toMatchObject({level: 'info', message: 'garbage'});
        const buffer = new LogBuffer(3);
        const seen: number[] = [];
        buffer.onEntry((e) => seen.push(e.id));
        for (let i = 0; i < 5; i++) {
            buffer.sink(`2026-10-24T10:00:00.000Z INFO  line ${i}`);
        }
        expect(buffer.list().map((e) => e.message)).toEqual(['line 2', 'line 3', 'line 4']);
        expect(buffer.list(1).map((e) => e.message)).toEqual(['line 4']);
        expect(buffer.list(10, 4).map((e) => e.message)).toEqual(['line 4']);
        expect(seen).toEqual([1, 2, 3, 4, 5]);
    });
});

describe('previewStatus', () => {
    it('marks the stages after a failure as not reached', () => {
        const preview = previewStatus(
            {topic: 't', extract: '$.x', map: {a: 1}, unit: 'celsius'},
            '{"y":1}',
            'TemperatureMeasurement.measuredValue',
        );
        expect(preview.ok).toBe(false);
        expect(preview.stages.map((s) => [s.step, s.ok, s.reason])).toEqual([
            ['extract', false, '"$.x" not in payload'],
            ['map', false, 'not reached'],
            ['unit', false, 'not reached'],
            ['attribute', false, 'not reached'],
        ]);
        expect(previewStatus({topic: 't', codec: {module: 'x'}}, 'p').reason).toMatch(/codec/);
    });
});
