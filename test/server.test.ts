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
import type {DeviceConfig} from '../src/model/schema.ts';
import {ConfigStore} from '../src/server/config-store.ts';
import type {DiscoveredDevice, Importer} from '../src/server/importers.ts';
import {LogBuffer} from '../src/server/log-buffer.ts';
import {Server} from '../src/server/server.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {freeUdpPort, waitFor} from './helpers/util.ts';

let broker: Broker;
let dir: string;
let app: App;
let server: Server;
let base: string;
let observer: MqttClient;
const received: {topic: string; payload: string}[] = [];

/** a test double of an importer: what it discovers is set by the test */
class FakeImporter implements Importer {
    readonly kind = 'z2m' as const;
    devices: DiscoveredDevice[] = [];
    resyncs = 0;
    private readonly listeners = new Set<() => void>();

    discovered(): readonly DiscoveredDevice[] {
        return this.devices;
    }

    async resync(): Promise<void> {
        this.resyncs++;
        await Promise.resolve();
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    set(devices: DiscoveredDevice[]): void {
        this.devices = devices;
        for (const listener of this.listeners) {
            listener();
        }
    }
}

const importer = new FakeImporter();

function discovered(key: string, name: string, topic: string): DiscoveredDevice {
    const device: DeviceConfig = parseConfig({
        devices: {
            x: {
                name,
                vendor: 'IKEA',
                model: 'TRADFRI bulb',
                source: {kind: 'z2m', key, version: '2.0.0'},
                endpoints: [
                    {
                        deviceTypes: ['OnOffLight'],
                        bindings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: `zigbee2mqtt/${topic}`, extract: 'state', map: {ON: true, OFF: false}},
                                command: {
                                    topic: `zigbee2mqtt/${topic}/set`,
                                    format: {true: 'ON', false: 'OFF'},
                                    wrap: 'state',
                                },
                            },
                        ],
                    },
                ],
            },
        },
    }).devices.x!;
    return {key, name, vendor: 'IKEA', model: 'TRADFRI bulb', device};
}

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
                        bindings: [
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
                        bindings: [
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
        importers: [importer],
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
        expect(status.json.importers).toEqual(['z2m']);

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
                    bindings: [
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
                    bindings: [
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

        // a replacement rebuilds it: the same endpoint number, the new binding wired
        const before = created.json.number;
        const replaced = await api('PUT', '/api/devices/lamp', {
            ...created.json.device,
            name: 'Lamp 2',
            endpoints: [
                {
                    ...created.json.device.endpoints[0],
                    bindings: [
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
                endpoints: [{deviceTypes: ['OnOffLight'], bindings: [{attribute: 'OnOff.nope', status: {topic: 't'}}]}],
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
                        {deviceTypes: ['OnOffLight'], bindings: [{attribute: 'OnOff.nope', status: {topic: 't'}}]},
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
        expect(list.json.presets).toEqual([
            expect.objectContaining({id: 'tasmota/relay', shipped: true}),
            expect.objectContaining({id: 'test/relay', name: 'Test relay', shipped: false}),
        ]);
        const applied = await api('POST', '/api/presets/test%2Frelay/apply', {values: {topic: 'sonoff1'}});
        expect(applied.json.device.name).toBe('Relay');
        expect(applied.json.device.endpoints[0].bindings[0].status.topic).toBe('stat/sonoff1/POWER');
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

    it('adopts discovered devices, shows diffs on re-sync and marks orphans without removing them', async () => {
        importer.set([discovered('0x1', 'Bulb one', 'bulb_one'), discovered('0x2', 'Bulb two', 'bulb_two')]);
        let list = await api('GET', '/api/adopt');
        expect(list.json.entries.map((e: any) => [e.sourceKey, e.state, e.deviceKey])).toEqual([
            ['0x1', 'new', '0x1'],
            ['0x2', 'new', '0x2'],
        ]);

        const adopted = await api('POST', '/api/adopt/z2m/0x1', {key: 'bulb-one'});
        expect(adopted.status).toBe(200);
        expect(adopted.json.key).toBe('bulb-one');
        expect(adopted.json.device.source).toEqual({kind: 'z2m', key: '0x1', version: '2.0.0', orphaned: false});
        expect(adopted.json.built).toBe(true);
        expect((await api('POST', '/api/adopt/z2m/0x2', {key: 'bulb-one'})).status).toBe(409);

        // the source changes: the entry shows the diff, adopting again takes it
        importer.set([discovered('0x1', 'Bulb one', 'bulb_one_renamed'), discovered('0x2', 'Bulb two', 'bulb_two')]);
        list = await api('GET', '/api/adopt');
        const changed = list.json.entries.find((e: any) => e.sourceKey === '0x1');
        expect(changed.state).toBe('changed');
        expect(changed.changes).toEqual([
            {
                path: 'endpoints[0].bindings[0].status.topic',
                before: 'zigbee2mqtt/bulb_one',
                after: 'zigbee2mqtt/bulb_one_renamed',
            },
            {
                path: 'endpoints[0].bindings[0].command.topic',
                before: 'zigbee2mqtt/bulb_one/set',
                after: 'zigbee2mqtt/bulb_one_renamed/set',
            },
        ]);
        const updated = await api('POST', '/api/adopt/z2m/0x1', {});
        expect(updated.json.device.endpoints[0].bindings[0].status.topic).toBe('zigbee2mqtt/bulb_one_renamed');
        list = await api('GET', '/api/adopt');
        expect(list.json.entries.find((e: any) => e.sourceKey === '0x1').state).toBe('adopted');

        // the source forgets the device: orphaned, still configured, still built
        importer.set([discovered('0x2', 'Bulb two', 'bulb_two')]);
        const resynced = await api('POST', '/api/adopt/resync');
        expect(importer.resyncs).toBe(1);
        expect(resynced.json.entries.find((e: any) => e.sourceKey === '0x1')).toMatchObject({
            state: 'orphaned',
            deviceKey: 'bulb-one',
        });
        const device = await api('GET', '/api/devices/bulb-one');
        expect(device.json.device.source.orphaned).toBe(true);
        expect(device.json.built).toBe(true);
        const file = JSON.parse(await readFile(join(dir, 'mqtt2matter.json'), 'utf8'));
        expect(file.devices['bulb-one'].source.orphaned).toBe(true);

        // removal is a click
        expect((await api('DELETE', '/api/devices/bulb-one')).status).toBe(204);
        expect((await api('GET', '/api/devices/bulb-one')).status).toBe(404);
        expect((await api('DELETE', '/api/devices/bulb-one')).status).toBe(404);
    }, 30_000);

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
