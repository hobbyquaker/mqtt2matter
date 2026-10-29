/* The web server against the real application: an in-process broker, a matter.js node, the config
   file in a temporary directory, the server on an ephemeral port. Every route of docs/api.md is
   exercised once; the adopt routes run against a test double of the importer interface. */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- the answers are JSON */

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocket} from 'ws';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {createLogger} from '../src/log.ts';
import {ConfigStore} from '../src/server/config-store.ts';
import {HaImporter, Z2mImporter} from '../src/server/importers.ts';
import {LogBuffer} from '../src/server/log-buffer.ts';
import {Server} from '../src/server/server.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {corpusMessages} from './helpers/ha-corpus.ts';
import {freeUdpPort, waitFor} from './helpers/util.ts';

let broker: Broker;
let dir: string;
let app: App;
let server: Server;
let base: string;
let observer: MqttClient;
const received: {topic: string; payload: string}[] = [];

const importer = new Z2mImporter('zigbee2mqtt');
const haImporter = new HaImporter('homeassistant');
const LIGHT = 'z2m:0xa4c138071003495f';
const fixture = join(import.meta.dirname, 'fixtures', 'z2m', 'bridge-devices.json');

async function api(method: string, path: string, body?: unknown): Promise<{status: number; json: any}> {
    const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
    });
    const text = await response.text();
    return {status: response.status, json: text === '' ? undefined : JSON.parse(text)};
}

beforeAll(async () => {
    broker = await startBroker();
    dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-server-'));
    const port = await freeUdpPort();
    const raw = {
        mqtt: {url: broker.url},
        storage: join(dir, 'data'),
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        presets: [join(dir, 'presets')],
        devices: {
            'plug-1': {
                name: 'Test plug',
                endpoints: [
                    {
                        deviceTypes: ['OnOffPlugInUnit'],
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'stat/plug1/POWER', map: {ON: true, OFF: false}},
                                command: {topic: 'cmnd/plug1/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                        ],
                    },
                ],
            },
        },
    };
    const path = join(dir, 'mqtt2matter.json');
    await writeFile(path, JSON.stringify(raw));
    await mkdir(join(dir, 'presets'), {recursive: true});
    await writeFile(
        join(dir, 'presets', 'relay.json'),
        JSON.stringify({
            id: 'test/relay',
            name: 'Test relay',
            variables: {topic: {label: 'Topic'}, name: {label: 'Name', default: 'Relay'}},
            device: {
                name: '%name%',
                endpoints: [
                    {
                        deviceTypes: ['OnOffPlugInUnit'],
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'stat/%topic%/POWER', map: {ON: true, OFF: false}},
                                command: {topic: 'cmnd/%topic%/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                        ],
                    },
                ],
            },
        }),
    );
    const config = parseConfig({...raw, server: {port: 0, host: '127.0.0.1'}});
    const logBuffer = new LogBuffer();
    const log = createLogger('debug', logBuffer.sink);
    app = new App(config, {log, mqttConnectTimeout: 5000});
    const store = new ConfigStore({path, raw, config, overridden: ['mqtt.url']});
    server = new Server({
        app,
        store,
        log: log.child('server'),
        logBuffer,
        version: 'test',
        host: '127.0.0.1',
        port: 0,
        uiDir: join(dir, 'no-ui'),
        importers: [importer, haImporter],
        topics: ['#'],
    });
    await server.listen();
    base = `http://127.0.0.1:${server.port}`;
    await app.start();
    await server.start();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync('cmnd/#');
    observer.on('message', (topic, payload) => received.push({topic, payload: payload.toString()}));
}, 60_000);

afterAll(async () => {
    await observer.endAsync();
    await server.close();
    await app.stop();
    await broker.close();
    await rm(dir, {recursive: true, force: true});
});

describe('the web server', () => {
    it('answers status, config, catalogue and the device list', async () => {
        const status = await api('GET', '/api/status');
        expect(status.status).toBe(200);
        expect(status.json.version).toBe('test');
        expect(status.json.running).toBe(true);
        expect(status.json.mqtt.connected).toBe(true);
        expect(status.json.bridges[0].id).toBe('default');
        expect(status.json.importers).toEqual(['z2m', 'ha-discovery']);

        const config = await api('GET', '/api/config');
        expect(config.json.settings.mqtt.url).toBe(broker.url);
        expect(config.json.overridden).toEqual(['mqtt.url']);
        expect(config.json.settings.devices).toBeUndefined();

        const catalog = await api('GET', '/api/catalog');
        expect(catalog.json.deviceTypes.find((d: any) => d.name === 'OnOffLight').clusters).toEqual(
            expect.arrayContaining([
                expect.objectContaining({cluster: 'OnOff', mandatory: true, features: ['Lighting']}),
            ]),
        );
        expect(catalog.json.clusters).toContain('WindowCovering');
        expect(catalog.json.units).toContain('celsius');
        const cluster = await api('GET', '/api/catalog/clusters/LevelControl');
        const level = cluster.json.attributes.find((a: any) => a.name === 'currentLevel');
        expect(level).toMatchObject({metatype: 'integer', nullable: true, writable: false});
        expect(cluster.json.commands.map((c: any) => c.name)).toContain('moveToLevelWithOnOff');
        expect((await api('GET', '/api/catalog/clusters/Nope')).status).toBe(404);

        const devices = await api('GET', '/api/devices');
        expect(devices.json).toEqual([
            expect.objectContaining({
                key: 'plug-1',
                name: 'Test plug',
                enabled: true,
                deviceTypes: ['OnOffPlugInUnit'],
                bridge: 'default',
                built: true,
                errors: 0,
                reachable: true,
            }),
        ]);
        expect(devices.json[0].number).toBeGreaterThan(1);
    });

    it('answers the statistics: the process figures and the counts', async () => {
        // a message the UI's subscription sees counts towards the rate and the topic cache
        observer.publish('test/stats/ping', '1');
        await waitFor(async () => {
            const figures = (await api('GET', '/api/stats')).json;
            return figures.mqttTopics > 0 && figures.mqttMessagesPerSecond > 0;
        });
        const stats = await api('GET', '/api/stats');
        expect(stats.status).toBe(200);
        expect(stats.json).toMatchObject({
            devices: 1,
            endpoints: 1,
            bridges: 1,
            bridgesCommissioned: 0,
            fabrics: 0,
            mqttConnected: true,
        });
        for (const key of [
            'uptime',
            'memoryMb',
            'heapMb',
            'cpuPercent',
            'eluPercent',
            'lagMeanMs',
            'lagMaxMs',
            'window',
        ]) {
            expect(typeof stats.json[key], key).toBe('number');
            expect(Number.isFinite(stats.json[key]), key).toBe(true);
        }
        expect(stats.json.memoryMb).toBeGreaterThan(0);
        expect(stats.json.mqttMessagesPerSecond).toBeGreaterThan(0);
    });

    it('refuses a settings change the environment owns and accepts one it does not', async () => {
        const settings = (await api('GET', '/api/config')).json.settings;
        const refused = await api('PUT', '/api/config', {...settings, mqtt: {url: 'mqtt://elsewhere'}});
        expect(refused.status).toBe(409);
        const accepted = await api('PUT', '/api/config', {...settings, log: {level: 'warn', matter: 'error'}});
        expect(accepted.json).toEqual({saved: true, restartNeeded: true});
        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(file.log).toEqual({level: 'warn', matter: 'error'});
        expect(file.devices['plug-1'].name).toBe('Test plug');
        expect((await api('PUT', '/api/config', {...settings, bridges: {}})).status).toBe(400);
    });

    it('creates a device live, reads its state, and the file keeps it compact', async () => {
        const created = await api('PUT', '/api/devices/lamp', {
            name: 'Lamp',
            endpoints: [
                {
                    deviceTypes: ['DimmableLight'],
                    mappings: [
                        {
                            attribute: 'OnOff.onOff',
                            status: {topic: 'stat/lamp/POWER', map: {ON: true, OFF: false}},
                            command: {topic: 'cmnd/lamp/POWER', format: {true: 'ON', false: 'OFF'}},
                        },
                        {
                            attribute: 'LevelControl.currentLevel',
                            status: {topic: 'stat/lamp/RESULT', extract: '$.Dimmer', unit: 'percentLevel'},
                            command: {topic: 'cmnd/lamp/Dimmer', unit: 'percentLevel', round: 0},
                        },
                    ],
                },
            ],
        });
        expect(created.status).toBe(200);
        expect(created.json.built).toBe(true);
        expect(created.json.number).toBeGreaterThan(1);
        expect(created.json.device.enabled).toBe(true);
        expect(created.json.state.main.state.OnOff.onOff).toBe(false);

        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(file.devices.lamp).toEqual({
            name: 'Lamp',
            endpoints: [
                {
                    deviceTypes: ['DimmableLight'],
                    mappings: [
                        {
                            attribute: 'OnOff.onOff',
                            status: {topic: 'stat/lamp/POWER', map: {ON: true, OFF: false}},
                            command: {topic: 'cmnd/lamp/POWER', format: {true: 'ON', false: 'OFF'}},
                        },
                        {
                            attribute: 'LevelControl.currentLevel',
                            status: {topic: 'stat/lamp/RESULT', extract: '$.Dimmer', unit: 'percentLevel'},
                            command: {topic: 'cmnd/lamp/Dimmer', unit: 'percentLevel', round: 0},
                        },
                    ],
                },
            ],
        });

        // a status report reaches the new endpoint
        await observer.publishAsync('stat/lamp/RESULT', '{"Dimmer":50}');
        await waitFor(
            async () => (await api('GET', '/api/devices/lamp/state')).json.main.state.LevelControl.currentLevel === 127,
        );

        // a replacement rebuilds it: the same endpoint number, the new mapping wired
        const before = created.json.number;
        const replaced = await api('PUT', '/api/devices/lamp', {
            ...created.json.device,
            name: 'Lamp 2',
            endpoints: [
                {
                    ...created.json.device.endpoints[0],
                    mappings: [
                        {
                            attribute: 'OnOff.onOff',
                            status: {topic: 'stat/lamp2/POWER', map: {ON: true, OFF: false}},
                        },
                    ],
                },
            ],
        });
        expect(replaced.json.number).toBe(before);
        await observer.publishAsync('stat/lamp2/POWER', 'ON');
        await waitFor(async () => (await api('GET', '/api/devices/lamp/state')).json.main.state.OnOff.onOff === true);
    });

    it('creates a device only where the key is free', async () => {
        const device = {name: 'Second plug', endpoints: [{deviceTypes: ['OnOffPlugInUnit']}]};
        const created = await api('POST', '/api/devices', {key: 'plug-2', device});
        expect(created.status).toBe(201);
        expect(created.json.key).toBe('plug-2');
        expect(created.json.device.name).toBe('Second plug');
        // the same key again: refused, the first device untouched
        const again = await api('POST', '/api/devices', {key: 'plug-2', device: {...device, name: 'Third plug'}});
        expect(again.status).toBe(409);
        expect(again.json.details).toEqual({key: 'plug-2'});
        expect((await api('GET', '/api/devices/plug-2')).json.device.name).toBe('Second plug');
        expect((await api('POST', '/api/devices', {device})).status).toBe(400);
        expect((await api('POST', '/api/devices', {key: 'bad key', device})).status).toBe(400);
        const dotted = await api('POST', '/api/devices', {key: 'plug.3', device});
        expect(dotted.status).toBe(400);
        expect(JSON.stringify(dotted.json)).toMatch(/plug\.3: .*no \\"\.\\"/);
        expect((await api('PUT', '/api/devices/plug.3', device)).status).toBe(400);
        expect((await api('DELETE', '/api/devices/plug-2')).status).toBe(204);
    });

    it('refuses an invalid device with the issues, validates and checks', async () => {
        const invalid = await api('PUT', '/api/devices/bad', {name: 'Bad', endpoints: [{deviceTypes: []}]});
        expect(invalid.status).toBe(400);
        expect(invalid.json.details.issues[0].path).toBe('endpoints.0.deviceTypes');
        expect(
            (await api('PUT', '/api/devices/bad key', {name: 'x', endpoints: [{deviceTypes: ['OnOffLight']}]})).status,
        ).toBe(400);

        const validated = await api('POST', '/api/validate', {
            device: {
                name: 'Odd',
                endpoints: [{deviceTypes: ['OnOffLight'], mappings: [{attribute: 'OnOff.nope', status: {topic: 't'}}]}],
            },
        });
        expect(validated.json.ok).toBe(false);
        expect(validated.json.issues[0].message).toMatch(/nope/);

        const check = await api('POST', '/api/check', {});
        expect(check.json.ok).toBe(true);
        const checkOne = await api('POST', '/api/check', {
            devices: {
                odd: {
                    name: 'Odd',
                    endpoints: [
                        {deviceTypes: ['OnOffLight'], mappings: [{attribute: 'OnOff.nope', status: {topic: 't'}}]},
                    ],
                },
            },
        });
        expect(checkOne.json.ok).toBe(false);
        expect(Object.keys(checkOne.json.devices)).toEqual(['odd']);
    }, 30_000);

    it('previews both directions step by step', async () => {
        const status = await api('POST', '/api/preview', {
            direction: 'status',
            attribute: 'LevelControl.currentLevel',
            half: {topic: 'stat/x/RESULT', extract: '$.Dimmer', unit: 'percentLevel'},
            payload: '{"Dimmer":50}',
        });
        expect(status.json.ok).toBe(true);
        expect(status.json.stages.map((s: any) => [s.step, s.value])).toEqual([
            ['extract', 50],
            ['unit', 127],
            ['attribute', 127],
        ]);
        const failed = await api('POST', '/api/preview', {
            direction: 'status',
            attribute: 'OnOff.onOff',
            half: {topic: 'stat/x/POWER', map: {ON: true, OFF: false}},
            payload: 'TOGGLE',
        });
        expect(failed.json.ok).toBe(false);
        expect(failed.json.stages[0]).toMatchObject({step: 'map', ok: false});
        const command = await api('POST', '/api/preview', {
            direction: 'command',
            attribute: 'OnOff.onOff',
            half: {topic: 'cmnd/x/POWER', format: {true: 'ON', false: 'OFF'}, wrap: 'state'},
            value: true,
        });
        expect(command.json.result).toBe('{"state":"ON"}');
        expect(command.json.stages.map((s: any) => s.step)).toEqual(['value', 'format', 'wrap', 'payload']);
        expect((await api('POST', '/api/preview', {direction: 'sideways'})).status).toBe(400);
    });

    it('publishes, lists the topic tree and streams events', async () => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`);
        const events: any[] = [];
        ws.on('message', (data) => events.push(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '{}')));
        await waitFor(() => events.length > 0, 5000, 'hello');
        expect(events[0]).toEqual({type: 'hello', version: 'test'});

        const published = await api('POST', '/api/publish', {topic: 'cmnd/test/X', payload: 'hello', retain: false});
        expect(published.json).toEqual({published: true});
        await waitFor(() => received.some((m) => m.topic === 'cmnd/test/X' && m.payload === 'hello'));
        await waitFor(() => events.some((e) => e.type === 'mqtt' && e.topic === 'cmnd/test/X'), 5000, 'mqtt event');

        const topics = await api('GET', '/api/topics?prefix=cmnd/test');
        expect(topics.json).toEqual([expect.objectContaining({topic: 'cmnd/test/X', payload: 'hello'})]);
        expect((await api('POST', '/api/publish', {payload: 'x'})).status).toBe(400);

        // a status report shows as an attribute event
        await observer.publishAsync('stat/plug1/POWER', 'ON');
        await waitFor(
            () =>
                events.some(
                    (e) => e.type === 'attribute' && e.key === 'plug-1' && e.cluster === 'OnOff' && e.value === true,
                ),
            5000,
            'attribute event',
        );
        // and a log line as a log event
        app.log.info('hello from the test');
        await waitFor(() => events.some((e) => e.type === 'log' && e.entry.message === 'hello from the test'), 5000);
        const log = await api('GET', '/api/log?limit=5');
        expect(log.json.length).toBeLessThanOrEqual(5);
        expect(log.json.some((e: any) => e.message === 'hello from the test')).toBe(true);
        ws.close();
    });

    it('lists presets and applies one without saving', async () => {
        const list = await api('GET', '/api/presets');
        const presets = list.json.presets as {id: string; shipped: boolean}[];
        expect(presets).toContainEqual(expect.objectContaining({id: 'tasmota/relay', shipped: true}));
        // the shipped ones first, the user's after them
        expect(presets.at(-1)).toEqual(expect.objectContaining({id: 'test/relay', name: 'Test relay', shipped: false}));
        expect(presets.slice(0, -1).every((p) => p.shipped)).toBe(true);
        const applied = await api('POST', '/api/presets/test%2Frelay/apply', {values: {topic: 'sonoff1'}});
        expect(applied.json.device.name).toBe('Relay');
        expect(applied.json.device.endpoints[0].mappings[0].status.topic).toBe('stat/sonoff1/POWER');
        expect(applied.json.device.source).toEqual({kind: 'preset', key: 'test/relay', version: '1'});
        expect((await api('GET', '/api/devices')).json.map((d: any) => d.key)).not.toContain('Relay');
        expect((await api('POST', '/api/presets/none/apply', {values: {}})).status).toBe(404);
    });

    it('shows the bridges with pairing codes and opens a commissioning window', async () => {
        const bridges = await api('GET', '/api/bridges');
        expect(bridges.json).toEqual([
            expect.objectContaining({
                id: 'default',
                online: true,
                commissioned: false,
                fabrics: [],
                windowStatus: expect.any(Number),
            }),
        ]);
        expect(bridges.json[0].pairingCodes.qrPairingCode).toMatch(/^MT:/);
        const opened = await api('POST', '/api/bridges/default/commissioning', {open: true, minutes: 3});
        expect(opened.status).toBe(200);
        expect(opened.json.id).toBe('default');
        expect((await api('POST', '/api/bridges/none/commissioning', {open: true})).status).toBe(404);
        expect((await api('DELETE', '/api/bridges/default/fabrics/7')).status).toBe(404);
    });

    it('adopts zigbee2mqtt devices, re-syncs them and marks orphans without removing them', async () => {
        const corpus = JSON.parse(await readFile(fixture, 'utf8')) as {ieee_address?: string; friendly_name?: string}[];
        const entryOf = async (key: string): Promise<any> =>
            (await api('GET', '/api/adopt')).json.entries.find((e: any) => e.key === key);
        await observer.publishAsync('zigbee2mqtt/bridge/devices', JSON.stringify(corpus), {retain: true});
        await waitFor(async () => (await entryOf(LIGHT)) !== undefined, 10_000, 'discovery');
        let list = await api('GET', '/api/adopt');
        expect(list.json.importers).toEqual(['z2m', 'ha-discovery']);
        expect(await entryOf(LIGHT)).toMatchObject({
            status: 'new',
            importer: 'z2m',
            kind: 'device',
            name: 'Gledopto RGBCTT light I',
            conflicts: [],
        });
        const unsupported = list.json.entries.find((e: any) => e.status === 'unsupported');
        expect(unsupported.notes.length).toBeGreaterThan(0);

        const adopted = await api('POST', `/api/adopt/z2m/${encodeURIComponent(LIGHT)}`, {});
        expect(adopted.status).toBe(200);
        expect(adopted.json.key).toBe(LIGHT);
        expect(adopted.json.device.source).toMatchObject({kind: 'z2m', key: '0xa4c138071003495f'});
        expect(adopted.json.built).toBe(true);
        expect(adopted.json.entry.status).toBe('new');
        expect((await api('GET', '/api/devices')).json.map((d: any) => d.key)).toContain(LIGHT);
        expect((await entryOf(LIGHT)).status).toBe('unchanged');
        expect((await api('POST', `/api/adopt/z2m/${encodeURIComponent(unsupported.key)}`, {})).status).toBe(409);
        expect((await api('POST', '/api/adopt/z2m/nope', {})).status).toBe(404);
        expect((await api('POST', '/api/adopt/ha-discovery/x', {})).status).toBe(404);
        expect((await api('POST', '/api/adopt/nope/x', {})).status).toBe(404);

        // zigbee2mqtt renames the light: the entry is updated, adopting again takes the new name and topics
        const renamed = corpus.map((d) =>
            d.ieee_address === '0xa4c138071003495f' ? {...d, friendly_name: 'Gledopto renamed'} : d,
        );
        await observer.publishAsync('zigbee2mqtt/bridge/devices', JSON.stringify(renamed), {retain: true});
        await waitFor(async () => (await entryOf(LIGHT))?.status === 'updated', 10_000, 'updated');
        const updated = await api('POST', `/api/adopt/z2m/${encodeURIComponent(LIGHT)}`, {});
        expect(updated.json.device.name).toBe('Gledopto renamed');
        expect(updated.json.device.endpoints[0].mappings[0].status.topic).toBe('zigbee2mqtt/Gledopto renamed');
        expect((await entryOf(LIGHT)).status).toBe('unchanged');

        // the light disappears from zigbee2mqtt: orphaned on re-sync, still configured, still built
        const without = corpus.filter((d) => d.ieee_address !== '0xa4c138071003495f');
        await observer.publishAsync('zigbee2mqtt/bridge/devices', JSON.stringify(without), {retain: true});
        await waitFor(async () => (await entryOf(LIGHT))?.status === 'orphaned', 10_000, 'orphaned');
        const resynced = await api('POST', '/api/adopt/resync');
        expect(resynced.json.written).toEqual([LIGHT]);
        const device = await api('GET', `/api/devices/${encodeURIComponent(LIGHT)}`);
        expect(device.json.device.source.orphaned).toBe(true);
        expect(device.json.built).toBe(true);
        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(file.devices[LIGHT].source.orphaned).toBe(true);

        // back again: restored by the next re-sync
        await observer.publishAsync('zigbee2mqtt/bridge/devices', JSON.stringify(corpus), {retain: true});
        await waitFor(async () => (await entryOf(LIGHT))?.status === 'restored', 10_000, 'restored');
        await api('POST', '/api/adopt/resync');
        expect((await api('GET', `/api/devices/${encodeURIComponent(LIGHT)}`)).json.device.source.orphaned).toBeFalsy();

        // removal is a click
        expect((await api('DELETE', `/api/devices/${encodeURIComponent(LIGHT)}`)).status).toBe(204);
        expect((await entryOf(LIGHT)).status).toBe('new');
        list = await api('GET', '/api/adopt');
        expect(list.json.entries.length).toBeGreaterThan(30);
    }, 60_000);

    it('adopts a Home Assistant discovery device, shows its area, orphans it on an empty payload', async () => {
        const KEY = 'ha:aa0000000002';
        const entryOf = async (key: string): Promise<any> =>
            (await api('GET', '/api/adopt')).json.entries.find((e: any) => e.key === key);
        const topics = [
            'homeassistant/switch/usb-relay-02/relay/config',
            'homeassistant/binary_sensor/usb-relay-02/button/config',
        ];
        const messages = corpusMessages('esphome').filter((m) => topics.includes(m.topic));
        expect(messages).toHaveLength(2);
        for (const message of messages) {
            await observer.publishAsync(message.topic, message.payload, {retain: true});
        }
        await waitFor(async () => (await entryOf(KEY)) !== undefined, 10_000, 'discovery');
        expect(await entryOf(KEY)).toMatchObject({
            status: 'new',
            importer: 'ha-discovery',
            kind: 'device',
            name: 'Fairy lights',
            area: 'Küche',
            unmapped: [
                'binary_sensor "button": no device_class; a binary sensor without one has no Matter sensor type',
            ],
        });
        const adopted = await api('POST', `/api/adopt/ha-discovery/${encodeURIComponent(KEY)}`, {});
        expect(adopted.status).toBe(200);
        expect(adopted.json.device.source).toMatchObject({kind: 'ha-discovery', key: 'aa0000000002'});
        expect(adopted.json.device.endpoints[0].attributes.Descriptor.tagList[0]).toMatchObject({
            namespaceId: 16,
            tag: 47,
        });
        expect(adopted.json.built).toBe(true);
        expect((await entryOf(KEY)).status).toBe('unchanged');

        // the device withdraws its discovery: orphaned on re-sync, never removed
        for (const topic of topics) {
            await observer.publishAsync(topic, '', {retain: true});
        }
        await waitFor(async () => (await entryOf(KEY))?.status === 'orphaned', 10_000, 'orphaned');
        const resynced = await api('POST', '/api/adopt/resync');
        expect(resynced.json.written).toEqual([KEY]);
        expect((await api('GET', `/api/devices/${encodeURIComponent(KEY)}`)).json.device.source.orphaned).toBe(true);
        expect((await api('DELETE', `/api/devices/${encodeURIComponent(KEY)}`)).status).toBe(204);
    }, 60_000);

    it('never adopts one Zigbee device twice without being told: natively and through its HA discovery', async () => {
        const IEEE = '0x00158d00091e7bd6';
        const NATIVE = `z2m:${IEEE}`;
        const HA = `ha:zigbee2mqtt_${IEEE}`;
        const topic = `homeassistant/binary_sensor/${IEEE}/contact/config`;
        const entryOf = async (key: string): Promise<any> =>
            (await api('GET', '/api/adopt')).json.entries.find((e: any) => e.key === key);
        await observer.publishAsync('zigbee2mqtt/bridge/devices', await readFile(fixture, 'utf8'), {retain: true});
        await observer.publishAsync(
            topic,
            JSON.stringify({
                name: null,
                unique_id: `${IEEE}_contact`,
                device_class: 'door',
                state_topic: 'zigbee2mqtt/contact',
                value_template: '{{ value_json.contact }}',
                payload_on: false,
                payload_off: true,
                device: {identifiers: [`zigbee2mqtt_${IEEE}`], name: 'Contact'},
                origin: {name: 'Zigbee2MQTT', sw: '2.9.2'},
            }),
            {retain: true},
        );
        await waitFor(async () => (await entryOf(HA)) !== undefined, 10_000, 'discovery');
        expect(await entryOf(HA)).toMatchObject({status: 'covered', covered: NATIVE, native: NATIVE});
        expect(await entryOf(NATIVE)).toMatchObject({status: 'new'});

        // the HA side: refused without force, adopted when forced
        const refused = await api('POST', `/api/adopt/ha-discovery/${encodeURIComponent(HA)}`, {});
        expect(refused.status).toBe(409);
        expect(refused.json.details).toEqual({covered: NATIVE, twins: []});
        const forced = await api('POST', `/api/adopt/ha-discovery/${encodeURIComponent(HA)}`, {force: true});
        expect(forced.status).toBe(200);

        // the native side is now covered by the adopted twin: refused, then replacing it
        expect(await entryOf(NATIVE)).toMatchObject({status: 'covered', covered: HA, twins: [HA]});
        expect((await api('POST', `/api/adopt/z2m/${encodeURIComponent(NATIVE)}`, {})).status).toBe(409);
        const replaced = await api('POST', `/api/adopt/z2m/${encodeURIComponent(NATIVE)}`, {
            force: true,
            replace: true,
        });
        expect(replaced.status).toBe(200);
        expect(replaced.json.built).toBe(true);
        const twin = await api('GET', `/api/devices/${encodeURIComponent(HA)}`);
        expect(twin.json.device.enabled).toBe(false);
        expect(twin.json.built).toBe(false);
        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(file.devices[HA].enabled).toBe(false);
        expect(file.devices[NATIVE]).toBeDefined();

        await observer.publishAsync(topic, '', {retain: true});
        expect((await api('DELETE', `/api/devices/${encodeURIComponent(HA)}`)).status).toBe(204);
        expect((await api('DELETE', `/api/devices/${encodeURIComponent(NATIVE)}`)).status).toBe(204);
    }, 60_000);

    it('exports and imports', async () => {
        const all = await fetch(`${base}/api/export`);
        expect(all.headers.get('content-disposition')).toContain('mqtt2matter.json');
        const exported = (await all.json()) as {devices: Record<string, any>};
        expect(Object.keys(exported.devices)).toEqual(expect.arrayContaining(['plug-1', 'lamp']));
        const one = await api('GET', '/api/export?device=lamp');
        expect(Object.keys(one.json)).toEqual(['lamp']);
        expect((await api('GET', '/api/export?device=none')).status).toBe(404);

        const imported = await api('POST', '/api/import', {
            devices: {
                'plug-9': {name: 'Nine', endpoints: [{deviceTypes: ['OnOffPlugInUnit']}]},
                lamp: {...one.json.lamp, name: 'Imported lamp'},
            },
        });
        expect(imported.json).toEqual({imported: 2});
        const devices = (await api('GET', '/api/devices')).json;
        expect(devices.find((d: any) => d.key === 'lamp').name).toBe('Imported lamp');
        expect(devices.find((d: any) => d.key === 'plug-9').built).toBe(true);

        const replaced = await api('POST', '/api/import', {
            replace: true,
            config: {devices: {'plug-1': exported.devices['plug-1']}},
        });
        expect(replaced.json).toEqual({imported: 1});
        expect((await api('GET', '/api/devices')).json.map((d: any) => d.key)).toEqual(['plug-1']);
        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(Object.keys(file.devices)).toEqual(['plug-1']);
        expect((await api('POST', '/api/import', {devices: {bad: {name: 'x'}}})).status).toBe(400);
        expect((await api('POST', '/api/import', {})).status).toBe(400);
    }, 30_000);

    it('serves the UI, or says it is not built', async () => {
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(404);
        expect(await page.text()).toMatch(/not built/);
        expect((await api('GET', '/api/nothing')).status).toBe(404);
        expect((await api('PATCH', '/api/status')).status).toBe(405);
    });
});
