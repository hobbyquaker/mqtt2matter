/* Corpus devices adopted by the importer, built on a real matter.js node with an in-process broker:
   zigbee2mqtt-shaped state messages set the attributes, controller commands publish zigbee2mqtt-shaped
   `/set` payloads, availability drives reachable, the switch children carry their tags. */

import {mkdtemp, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {ColorControlServer, LevelControlServer, OnOffServer, WindowCoveringServer} from '../src/families/index.ts';
import {z2m} from '../src/importers/index.ts';
import {createLogger} from '../src/log.ts';
import type {DeviceHandle} from '../src/matter/bridge.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {freeUdpPort, settled, waitFor} from './helpers/util.ts';

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');

const LIGHT = 'z2m:0xa4c138071003495f';
const RELAY = 'z2m:0x54ef4410009716a8';
const COVER = 'z2m:0x70ac08fffee6dd5e';
const BUTTON = 'z2m:0x00158d0008066798';
const THERMO = 'z2m:0xa4c138f402dfba8a';
const CLIMATE = 'z2m:0x00158d000945f2b1';
const GROUP = 'z2m:group:7';
const FAN = 'z2m:0x00124b0000000003';
const KEYS = [LIGHT, RELAY, COVER, BUTTON, THERMO, CLIMATE, GROUP, FAN];

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
let app: App;
const published: {topic: string; payload: string}[] = [];
const logLines: string[] = [];

type Commands = Record<string, (request: Record<string, unknown>) => Promise<void>>;
const commands = (behavior: unknown): Commands => behavior as Commands;

async function publish(topic: string, payload: string): Promise<void> {
    await observer.publishAsync(topic, payload);
}

async function expectPublished(topic: string, payload: string, timeout = 5000): Promise<void> {
    await waitFor(
        () => published.some((p) => p.topic === topic && p.payload === payload),
        timeout,
        `${topic} ${payload}; got ${JSON.stringify(published)}`,
    );
}

function device(key: string): DeviceHandle {
    const handle = app.nodes.handle(key);
    if (handle === undefined) {
        throw new Error(`no device ${key}`);
    }
    return handle;
}

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-z2m-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync(['zigbee2mqtt/+/set', 'zigbee2mqtt/+/get']);
    observer.on('message', (topic, payload) => published.push({topic, payload: payload.toString()}));

    const discovery = z2m.discover({
        devices: [
            ...z2m.parseBridgeDevices(readFileSync(join(fixtures, 'bridge-devices.json'))),
            ...z2m.parseBridgeDevices(readFileSync(join(fixtures, 'starkvind.json'))),
        ],
        groups: z2m.parseBridgeGroups(readFileSync(join(fixtures, 'bridge-groups.json'))),
    });
    const {devices} = z2m.adopt({}, discovery, {keys: KEYS});
    const config = parseConfig({
        mqtt: {url: broker.url},
        storage,
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices,
    });
    app = new App(config, {mqttConnectTimeout: 5000, log: createLogger('warn', (line) => logLines.push(line))});
    await app.start();
}, 60_000);

afterAll(async () => {
    await app.stop();
    await observer.endAsync();
    await broker.close();
    await rm(storage, {recursive: true, force: true});
}, 60_000);

describe('the adopted devices', () => {
    it('build without errors or conformance violations and ask for their state', async () => {
        const info = app.nodes.info()[0]!;
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
        expect(info.devices.map((d) => d.key).sort()).toEqual([...KEYS].sort());
        expect(info.devices.every((d) => d.violations === 0)).toBe(true);
        await expectPublished('zigbee2mqtt/Gledopto RGBCTT light I/get', '{"state":""}');
        await expectPublished('zigbee2mqtt/Aqara Dual relay module T2/get', '{"state_l1":""}');
        await expectPublished('zigbee2mqtt/Window shutter/get', '{"position":""}');
        expect(published.some((p) => p.topic === 'zigbee2mqtt/Lights/get')).toBe(false);
    });

    it('the relay: two channels, two tagged buttons', () => {
        const relay = device(RELAY);
        expect([...relay.endpoints.keys()]).toEqual(['main', 'l2', 'button_l1', 'button_l2']);
        const l2 = relay.endpoints.get('l2')!;
        expect(JSON.parse(JSON.stringify(l2.state.descriptor!.tagList))).toEqual([
            {mfgCode: null, namespaceId: 7, tag: 1, label: 'l2'},
        ]);
        expect(relay.endpoints.get('button_l2')!.state.switch!.multiPressMax).toBe(2);
        expect(device(BUTTON).main.state.switch!.multiPressMax).toBe(4);
    });
});

describe('light', () => {
    it('status in zigbee2mqtt shape', async () => {
        const light = device(LIGHT);
        await publish(
            'zigbee2mqtt/Gledopto RGBCTT light I',
            JSON.stringify({
                state: 'ON',
                brightness: 254,
                color_temp: 300,
                color_mode: 'color_temp',
                color: {x: 0.3, y: 0.3},
            }),
        );
        await settled(() => {
            expect(light.state.levelControl!.currentLevel).toBe(254);
            expect(light.state.onOff!.onOff).toBe(true);
            expect(light.state.colorControl!.colorTemperatureMireds).toBe(300);
            expect(light.state.colorControl!.colorMode).toBe(2);
        });
        expect(light.state.colorControl!.colorTempPhysicalMinMireds).toBe(158);
        expect(light.state.colorControl!.colorTempPhysicalMaxMireds).toBe(495);
        await publish(
            'zigbee2mqtt/Gledopto RGBCTT light I',
            JSON.stringify({color_mode: 'xy', color: {x: 0.5, y: 0.4}}),
        );
        await settled(() => {
            expect(light.state.colorControl!.currentX).toBe(Math.round(0.5 * 65535));
            expect(light.state.colorControl!.colorMode).toBe(1);
        });
    });

    it('commands as one coalesced /set message', async () => {
        const light = device(LIGHT);
        published.length = 0;
        await light.endpoint.act((agent) =>
            commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({
                level: 127,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('zigbee2mqtt/Gledopto RGBCTT light I/set', '{"brightness":127,"state":"ON"}');
        await light.endpoint.act((agent) =>
            commands(agent.get(ColorControlServer)).moveToColorTemperature!({
                colorTemperatureMireds: 250,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('zigbee2mqtt/Gledopto RGBCTT light I/set', '{"color_temp":250}');
        await light.endpoint.act((agent) => commands(agent.get(OnOffServer)).off!({}));
        await expectPublished('zigbee2mqtt/Gledopto RGBCTT light I/set', '{"state":"OFF"}');
    });

    it('the group publishes on its own topic', async () => {
        const group = device(GROUP);
        await publish('zigbee2mqtt/Lights', JSON.stringify({state: 'ON', brightness: 100}));
        await waitFor(() => group.state.levelControl!.currentLevel === 100, 5000, 'group level');
        await group.endpoint.act((agent) => commands(agent.get(OnOffServer)).off!({}));
        await expectPublished('zigbee2mqtt/Lights/set', '{"state":"OFF"}');
    });
});

describe('relay channels', () => {
    it('status per property suffix, commands with the suffix on the device topic', async () => {
        const relay = device(RELAY);
        await publish('zigbee2mqtt/Aqara Dual relay module T2', JSON.stringify({state_l1: 'ON', state_l2: 'OFF'}));
        await settled(() => {
            expect(relay.main.state.onOff!.onOff).toBe(true);
            expect(relay.endpoints.get('l2')!.state.onOff!.onOff).toBe(false);
        });
        published.length = 0;
        await relay.endpoints.get('l2')!.endpoint.act((agent) => commands(agent.get(OnOffServer)).on!({}));
        await expectPublished('zigbee2mqtt/Aqara Dual relay module T2/set', '{"state_l2":"ON"}');
    });

    it('an action plays into the button of that channel', async () => {
        const relay = device(RELAY);
        const button = relay.endpoints.get('button_l2')!;
        await publish('zigbee2mqtt/Aqara Dual relay module T2', JSON.stringify({action: 'single_l2'}));
        await waitFor(() => button.state.switch!.currentPosition === 1, 5000, 'pressed');
        await waitFor(() => button.state.switch!.currentPosition === 0, 5000, 'released');
        expect(relay.endpoints.get('button_l1')!.state.switch!.currentPosition).toBe(0);
        await publish('zigbee2mqtt/Aqara Dual relay module T2', JSON.stringify({action: ''}));
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
    });
});

describe('cover', () => {
    it("positions on zigbee2mqtt's axis, movement from the moving report, stop", async () => {
        const cover = device(COVER);
        await publish('zigbee2mqtt/Window shutter', JSON.stringify({position: 100, moving: 'STOP'}));
        await waitFor(() => cover.state.windowCovering!.currentPositionLiftPercent100ths === 0, 5000, 'open');
        published.length = 0;
        await cover.endpoint.act((agent) =>
            commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({liftPercent100thsValue: 7500}),
        );
        await expectPublished('zigbee2mqtt/Window shutter/set', '{"position":25}');
        await publish('zigbee2mqtt/Window shutter', JSON.stringify({moving: 'DOWN'}));
        await waitFor(
            () =>
                JSON.stringify(cover.state.windowCovering!.operationalStatus) !==
                JSON.stringify({global: 0, lift: 0, tilt: 0}),
            5000,
            'moving',
        );
        await cover.endpoint.act((agent) => commands(agent.get(WindowCoveringServer)).stopMotion!({}));
        await expectPublished('zigbee2mqtt/Window shutter/set', '{"state":"STOP"}');
        await publish('zigbee2mqtt/Window shutter', JSON.stringify({position: 60, moving: 'STOP'}));
        await waitFor(
            () => cover.state.windowCovering!.currentPositionLiftPercent100ths === 4000,
            5000,
            'stopped at 40 %',
        );
    });
});

describe('thermostat and sensors', () => {
    it('the thermostat', async () => {
        const thermo = device(THERMO);
        await publish(
            'zigbee2mqtt/Moes thermo',
            JSON.stringify({
                local_temperature: 21.5,
                current_heating_setpoint: 23,
                system_mode: 'heat',
                running_state: 'heat',
            }),
        );
        await settled(() => {
            expect(thermo.state.thermostat!.localTemperature).toBe(2150);
            expect(thermo.state.thermostat!.occupiedHeatingSetpoint).toBe(2300);
            expect(thermo.state.thermostat!.systemMode).toBe(4);
        });
        expect(thermo.state.thermostat!.minHeatSetpointLimit).toBe(500);
        expect(thermo.state.thermostat!.maxHeatSetpointLimit).toBe(4500);
    });

    it('the climate sensor and its battery; availability drives reachable', async () => {
        const climate = device(CLIMATE);
        await publish(
            'zigbee2mqtt/Climate sensor',
            JSON.stringify({temperature: 19.25, humidity: 55.5, pressure: 1013.2, battery: 80, voltage: 2950}),
        );
        await settled(() => {
            expect(climate.state.temperatureMeasurement!.measuredValue).toBe(1925);
            expect(climate.state.relativeHumidityMeasurement!.measuredValue).toBe(5550);
            expect(climate.state.pressureMeasurement!.measuredValue).toBe(1013);
            expect(climate.state.powerSource!.batPercentRemaining).toBe(160);
            expect(climate.state.powerSource!.batVoltage).toBe(2950);
            expect(climate.state.bridgedDeviceBasicInformation!.reachable).toBe(true);
        });
        await publish('zigbee2mqtt/Climate sensor/availability', '{"state":"offline"}');
        await waitFor(() => climate.state.bridgedDeviceBasicInformation!.reachable === false, 5000, 'unreachable');
        await publish('zigbee2mqtt/Climate sensor/availability', 'online');
        await waitFor(() => climate.state.bridgedDeviceBasicInformation!.reachable === true, 5000, 'reachable');
    });
});

describe('a fan with numbered speeds', () => {
    it('every speed sets the percent and its third as the mode, auto Auto with no percent, without a warning', async () => {
        const fan = device(FAN);
        const steps: [string, number | null, number][] = [
            // fan_mode, percentSetting, fanMode (Off 0, Low 1, Medium 2, High 3, Auto 5)
            ['auto', null, 5],
            ['1', 11, 1],
            ['3', 33, 1],
            ['5', 56, 2],
            ['6', 67, 2],
            ['9', 100, 3],
            ['off', 0, 0],
        ];
        for (const [mode, percent, fanMode] of steps) {
            await publish(
                'zigbee2mqtt/starkvind',
                JSON.stringify({
                    fan_state: mode === 'off' ? 'OFF' : 'ON',
                    fan_mode: mode,
                    fan_speed: 1,
                    pm25: 3,
                    air_quality: 'excellent',
                }),
            );
            await settled(() => {
                expect(fan.state.fanControl!.fanMode).toBe(fanMode);
                expect(fan.state.fanControl!.percentSetting).toBe(percent);
            });
        }
        expect(logLines.filter((l) => l.includes('starkvind'))).toEqual([]);
    });

    it("a controller's percent write publishes the speed step its template computes", async () => {
        const fan = device(FAN);
        const events = (
            fan.endpoint.events as unknown as Record<
                string,
                Record<string, {emit(value: unknown, old: unknown, context: {offline: boolean}): void}>
            >
        ).fanControl!;
        published.length = 0;
        for (const [percent, step] of [
            [40, '4'],
            [100, '9'],
            [0, 'off'],
        ] as const) {
            await fan.endpoint.set({fanControl: {percentSetting: percent}} as never);
            events.percentSetting$Changed!.emit(percent, null, {offline: false});
            await expectPublished('zigbee2mqtt/starkvind/set', JSON.stringify({fan_mode: step}));
        }
        expect(logLines.filter((l) => l.includes('starkvind') && l.includes('failed'))).toEqual([]);
    });
});
