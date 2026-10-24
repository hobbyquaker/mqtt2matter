/* The server's pure parts: the compact file form round-trips, the log buffer, the preview stages. */

import {describe, expect, it} from 'vitest';

import {DeviceSchema} from '../src/model/schema.ts';
import {compactDevice} from '../src/server/compact.ts';
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
                    mappings: [
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
                    mappings: [
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
