/* The mapping runtime with fakes on both sides: subscriptions, decoding to targets, events, commands,
   coalescing, availability, expire and get requests — nothing of MQTT or matter.js. */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {Decoded} from '../src/engine/payload.ts';
import {type CommandHandler, type EndpointTarget, MappingRuntime, evaluateAvailability} from '../src/engine/runtime.ts';
import {silentLogger} from '../src/log.ts';
import type {AttributeRef} from '../src/model/attribute.ts';
import {DeviceSchema} from '../src/model/schema.ts';

class FakeTarget implements EndpointTarget {
    sets: {key: string; value: Decoded}[] = [];
    events: {channel: string; value: Decoded}[] = [];
    handlers = new Map<string, CommandHandler>();
    reachable: boolean[] = [];

    shapeOf(ref: AttributeRef) {
        if (ref.attribute === 'systemMode') {
            return {
                metatype: 'enum' as const,
                enumMembers: new Map([
                    ['Heat', 4],
                    ['Off', 0],
                ]),
            };
        }
        if (ref.attribute === 'currentLevel') {
            return {metatype: 'integer' as const};
        }
        return undefined;
    }
    set(ref: AttributeRef, value: Decoded) {
        this.sets.push({key: `${ref.cluster}.${ref.attribute}`, value});
        return Promise.resolve();
    }
    emitEvent(channel: string, value: Decoded) {
        this.events.push({channel, value});
        return Promise.resolve();
    }
    onCommand(key: string, handler: CommandHandler | undefined) {
        if (handler === undefined) {
            this.handlers.delete(key);
        } else {
            this.handlers.set(key, handler);
        }
    }
    setReachable(reachable: boolean) {
        this.reachable.push(reachable);
        return Promise.resolve();
    }
}

function setup(deviceRaw: Record<string, unknown>) {
    const published: {topic: string; payload: string; retain: boolean; qos: number}[] = [];
    const runtime = new MappingRuntime(
        {
            publish: (topic, payload, {retain, qos}) => {
                published.push({topic, payload, retain, qos});
                return Promise.resolve();
            },
        },
        silentLogger,
    );
    const device = DeviceSchema.parse(deviceRaw);
    const targets = new Map<string, FakeTarget>();
    for (const endpoint of device.endpoints) {
        targets.set(endpoint.id, new FakeTarget());
    }
    runtime.bind('dev', device, targets);
    return {runtime, published, targets, main: targets.get(device.endpoints[0]!.id)!};
}

describe('MappingRuntime: status in', () => {
    it('subscribes the status topics and sets decoded values', async () => {
        const {runtime, main} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['Thermostat'],
                    mappings: [
                        {
                            attribute: 'Thermostat.systemMode',
                            status: {topic: 's', extract: 'mode', map: {heat: 'Heat'}},
                        },
                        {
                            attribute: 'LevelControl.currentLevel',
                            status: {topic: 's', extract: 'level', unit: 'byteLevel'},
                        },
                    ],
                },
            ],
        });
        expect(runtime.topics()).toEqual(['s']);
        await runtime.handleMessage('s', Buffer.from('{"mode":"heat","level":255}'));
        expect(main.sets).toEqual([
            {key: 'Thermostat.systemMode', value: 4},
            {key: 'LevelControl.currentLevel', value: 254},
        ]);
        await runtime.handleMessage('s', Buffer.from('{"mode":"cool"}'));
        expect(main.sets).toHaveLength(2);
    });

    it('routes event channels and child endpoints', async () => {
        const {runtime, targets} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['GenericSwitch'],
                    mappings: [{event: 'Switch', status: {topic: 'b', extract: 'action'}}],
                },
                {
                    id: 'l1',
                    deviceTypes: ['OnOffLight'],
                    mappings: [{attribute: 'OnOff.onOff', status: {topic: 'b', extract: 'state_l1', map: {ON: true}}}],
                },
            ],
        });
        await runtime.handleMessage('b', Buffer.from('{"action":"double","state_l1":"ON"}'));
        expect(targets.get('main')!.events).toEqual([{channel: 'Switch', value: 'double'}]);
        expect(targets.get('l1')!.sets).toEqual([{key: 'OnOff.onOff', value: true}]);
    });

    it('applies the messages of one topic in arrival order, even when they arrive back to back', async () => {
        const {runtime, main} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['DimmableLight'],
                    mappings: [
                        {attribute: 'OnOff.onOff', status: {topic: 's', extract: 'state', map: {ON: true}}},
                        {attribute: 'LevelControl.currentLevel', status: {topic: 's', extract: 'level'}},
                    ],
                },
            ],
        });
        // the MQTT client emits both before the first is through: the second must not overtake the first
        const first = runtime.handleMessage('s', Buffer.from('{"state":"ON","level":100}'));
        const second = runtime.handleMessage('s', Buffer.from('{"level":150}'));
        await Promise.all([first, second]);
        expect(main.sets.map((s) => s.value)).toEqual([true, 100, 150]);
    });

    it('announces new topics to listeners and forgets devices', () => {
        const {runtime} = setup({
            name: 'd',
            endpoints: [{deviceTypes: ['OnOffLight'], mappings: [{attribute: 'OnOff.onOff', status: {topic: 'a'}}]}],
        });
        const seen: string[] = [];
        runtime.onTopic((t) => seen.push(t));
        expect(seen).toEqual(['a']);
        runtime.unbind('dev');
        expect(runtime.topics()).toEqual([]);
    });
});

describe('MappingRuntime: commands out', () => {
    it('registers a handler per command half and publishes through the engine', async () => {
        const {main, published} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['Thermostat'],
                    mappings: [
                        {
                            attribute: 'Thermostat.systemMode',
                            command: {topic: 'c', format: {Heat: 'heat', Off: 'off'}, retain: true, qos: 1},
                        },
                        {attribute: 'OnOff.onOff', status: {topic: 's'}, command: {topic: 'c2', format: {true: 'ON'}}},
                        {invoke: 'WindowCovering.stopMotion', command: {topic: 'c3', payload: 'STOP'}},
                    ],
                },
            ],
        });
        expect([...main.handlers.keys()]).toEqual([
            'Thermostat.systemMode',
            'OnOff.onOff',
            'WindowCovering.stopMotion',
        ]);
        expect(await main.handlers.get('Thermostat.systemMode')!(4, {})).toBe(true);
        expect(await main.handlers.get('OnOff.onOff')!(true, {})).toBe(false);
        expect(await main.handlers.get('WindowCovering.stopMotion')!('stop', {})).toBe(true);
        expect(published).toEqual([
            {topic: 'c', payload: 'heat', retain: true, qos: 1},
            {topic: 'c2', payload: 'ON', retain: false, qos: 0},
            {topic: 'c3', payload: 'STOP', retain: false, qos: 0},
        ]);
    });

    it('coalesces JSON payloads to one topic within the window', async () => {
        vi.useFakeTimers();
        try {
            const {main, published} = setup({
                name: 'd',
                endpoints: [
                    {
                        deviceTypes: ['DimmableLight'],
                        coalesce: 50,
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                command: {topic: 'c', wrap: 'state', format: {true: 'ON', false: 'OFF'}},
                            },
                            {attribute: 'LevelControl.currentLevel', command: {topic: 'c', wrap: 'brightness'}},
                            {invoke: 'Identify.identify', command: {topic: 'c', payload: 'blink'}},
                        ],
                    },
                ],
            });
            await main.handlers.get('OnOff.onOff')!(true, {});
            await main.handlers.get('LevelControl.currentLevel')!(128, {});
            await vi.advanceTimersByTimeAsync(10);
            expect(published).toEqual([]);
            await vi.advanceTimersByTimeAsync(60);
            expect(published).toEqual([
                {topic: 'c', payload: '{"state":"ON","brightness":128}', retain: false, qos: 0},
            ]);
            // a non-JSON payload flushes what is pending and goes out at once
            await main.handlers.get('LevelControl.currentLevel')!(10, {});
            await main.handlers.get('Identify.identify')!('x', {});
            expect(published.slice(1)).toEqual([
                {topic: 'c', payload: '{"brightness":10}', retain: false, qos: 0},
                {topic: 'c', payload: 'blink', retain: false, qos: 0},
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('MappingRuntime: availability, expire, get', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('evaluates availability payloads', () => {
        const topic = {topic: 'a', online: 'online', offline: 'offline'};
        expect(evaluateAvailability(topic, 'online')).toBe(true);
        expect(evaluateAvailability(topic, 'offline')).toBe(false);
        expect(evaluateAvailability(topic, 'x')).toBeUndefined();
        expect(evaluateAvailability({...topic, extract: 'state'}, '{"state":"online"}')).toBe(true);
        expect(
            evaluateAvailability(
                {...topic, template: '{{ value_json.up | iif("online", "offline") }}'},
                '{"up":false}',
            ),
        ).toBe(false);
    });

    it('all / any / latest over several topics', async () => {
        for (const [mode, expected] of [
            ['all', [false, true, false, true]],
            ['any', [false, true]],
            ['latest', [false, true, false, true]],
        ] as const) {
            const {runtime, main} = setup({
                name: 'd',
                availability: {mode, topics: [{topic: 'a1'}, {topic: 'a2'}]},
                endpoints: [{deviceTypes: ['OnOffLight'], mappings: []}],
            });
            expect(runtime.topics().sort()).toEqual(['a1', 'a2']);
            await runtime.handleMessage('a1', Buffer.from('offline'));
            await runtime.handleMessage('a2', Buffer.from('online'));
            await runtime.handleMessage('a1', Buffer.from('online'));
            await runtime.handleMessage('a2', Buffer.from('offline'));
            await runtime.handleMessage('a2', Buffer.from('online'));
            expect(main.reachable, mode).toEqual(expected);
        }
    });

    it('a single availability topic in short form', async () => {
        const {runtime, main} = setup({
            name: 'd',
            availability: {topic: 'tele/LWT', online: 'Online', offline: 'Offline'},
            endpoints: [{deviceTypes: ['OnOffLight'], mappings: []}],
        });
        await runtime.handleMessage('tele/LWT', Buffer.from('Offline'));
        await runtime.handleMessage('tele/LWT', Buffer.from('Online'));
        expect(main.reachable).toEqual([false, true]);
    });

    it('expire marks the device unreachable until the next message', async () => {
        const {runtime, main} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['TemperatureSensor'],
                    mappings: [
                        {
                            attribute: 'TemperatureMeasurement.measuredValue',
                            status: {topic: 't', type: 'number', expire: 10},
                        },
                    ],
                },
            ],
        });
        await runtime.handleMessage('t', Buffer.from('21'));
        await vi.advanceTimersByTimeAsync(9_000);
        expect(main.reachable).toEqual([]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(main.reachable).toEqual([false]);
        await runtime.handleMessage('t', Buffer.from('22'));
        expect(main.reachable).toEqual([false, true]);
        runtime.close();
    });

    it('publishes the get requests', async () => {
        const {runtime, published} = setup({
            name: 'd',
            endpoints: [
                {
                    deviceTypes: ['OnOffLight'],
                    mappings: [
                        {
                            attribute: 'OnOff.onOff',
                            status: {
                                topic: 'z/light',
                                extract: 'state',
                                get: {topic: 'z/light/get', payload: '{"state":""}'},
                            },
                        },
                        {
                            attribute: 'LevelControl.currentLevel',
                            status: {topic: 'z/light', extract: 'brightness', get: {topic: 'z/light/get'}},
                        },
                    ],
                },
            ],
        });
        await runtime.publishGets();
        expect(published).toEqual([
            {topic: 'z/light/get', payload: '{"state":""}', retain: false, qos: 0},
            {topic: 'z/light/get', payload: '', retain: false, qos: 0},
        ]);
    });
});
