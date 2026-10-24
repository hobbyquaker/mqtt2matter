/* Corpus devices adopted by the Home Assistant discovery importer, built on a real matter.js node with
   an in-process broker: payloads in the publishers' shapes set the attributes through the templates,
   controller commands publish what the device expects, the area tag sits on the device's own endpoint,
   a charging state needs the Rechargeable feature, an event entity plays into its button. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {LevelControlServer, OnOffServer, WindowCoveringServer} from '../src/families/index.ts';
import {ha} from '../src/importers/index.ts';
import {createLogger} from '../src/log.ts';
import type {DeviceHandle} from '../src/matter/bridge.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {CORPUS, loadCorpus} from './helpers/ha-corpus.ts';
import {freeUdpPort, waitFor} from './helpers/util.ts';

const RELAY = 'ha:aa0000000002';
const SEEDLING = 'ha:aa0000000003';
const TASMOTA_LIGHT = 'ha:AABBCC';
const SHELLY_COVER = 'ha:shellyplus2pm-d4e5f6';
const SHELLY_I4 = 'ha:shellyplusi4-778899';
const HUE = 'ha:zigbee2mqtt_0x00124b0000000001';
const UPS = 'ha:nut2mqtt_nut_nutdev1';
const KEYS = [RELAY, SEEDLING, TASMOTA_LIGHT, SHELLY_COVER, SHELLY_I4, HUE, UPS];

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
let app: App;
const published: {topic: string; payload: string}[] = [];
const logLines: string[] = [];

type Commands = Record<string, (request: Record<string, unknown>) => Promise<void>>;
type Emitters = Record<
    string,
    Record<string, {emit(value: unknown, old: unknown, context: unknown): void}> | undefined
>;
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
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-ha-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync([
        'usb-relay-02/set/#',
        'seedling/#',
        'cmnd/#',
        'shellyplus2pm-d4e5f6/command/#',
        'zigbee2mqtt/+/set',
    ]);
    observer.on('message', (topic, payload) => published.push({topic, payload: payload.toString()}));

    const source = new ha.HaSource();
    loadCorpus(source, ...CORPUS);
    const {devices} = ha.adopt({}, source.discover(), {keys: KEYS});
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
    it('build without errors or conformance violations', () => {
        const info = app.nodes.info()[0]!;
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
        expect(info.devices.map((d) => d.key).sort()).toEqual([...KEYS].sort());
        expect(info.devices.every((d) => d.violations === 0)).toBe(true);
    });

    it('the area tag sits on the device’s own endpoint; the UPS carries the Rechargeable feature', () => {
        const relay = device(RELAY);
        expect(JSON.parse(JSON.stringify(relay.main.state.descriptor!.tagList))).toEqual([
            {mfgCode: null, namespaceId: 16, tag: 47, label: 'Küche'},
        ]);
        const ups = device(UPS);
        expect(ups.main.state.powerSource!.batChargeState).toBe(0);
    });
});

describe('ESPHome', () => {
    it('a relay: plain payloads both ways', async () => {
        const relay = device(RELAY);
        await publish('usb-relay-02/status/relay', 'ON');
        await waitFor(() => relay.main.state.onOff!.onOff === true, 5000, 'on');
        await relay.endpoint.act((agent) => commands(agent.get(OnOffServer)).off!({}));
        await expectPublished('usb-relay-02/set/relay', 'OFF');
    });

    it('a thermostat: temperatures, the mode by name, the setpoint back', async () => {
        const thermostat = device(SEEDLING);
        await publish('seedling/climate/thermostat/current_temperature/state', '21.5');
        await publish('seedling/climate/thermostat/target_temperature/state', '24');
        await publish('seedling/climate/thermostat/mode/state', 'heat');
        await waitFor(() => thermostat.main.state.thermostat!.localTemperature === 2150, 5000, 'local');
        await waitFor(() => thermostat.main.state.thermostat!.occupiedHeatingSetpoint === 2400, 5000, 'setpoint');
        await waitFor(() => thermostat.main.state.thermostat!.systemMode === 4, 5000, 'mode');
        // a controller's write: applied by matter.js, published from the change (as the families test does it)
        published.length = 0;
        await thermostat.endpoint.set({thermostat: {occupiedHeatingSetpoint: 2500, systemMode: 0}} as never);
        const events = (thermostat.endpoint.events as unknown as Emitters).thermostat!;
        events.occupiedHeatingSetpoint$Changed!.emit(2500, 2400, {offline: false});
        events.systemMode$Changed!.emit(0, 4, {offline: false});
        await expectPublished('seedling/climate/thermostat/target_temperature/command', '25');
        await expectPublished('seedling/climate/thermostat/mode/command', 'off');
    });
});

describe('Tasmota (default-schema light with templates)', () => {
    it('status from the STATE JSON through the value templates; commands to the cmnd topics', async () => {
        const light = device(TASMOTA_LIGHT);
        await publish(
            'tele/tasmota_AABBCC/STATE',
            JSON.stringify({POWER: 'ON', Dimmer: 50, CT: 300, Color: '255,0,0,0,0'}),
        );
        await waitFor(() => light.state.onOff!.onOff === true, 5000, 'on');
        expect(light.state.levelControl!.currentLevel).toBe(126);
        expect(light.state.colorControl!.colorTemperatureMireds).toBe(300);
        published.length = 0;
        await light.endpoint.act((agent) =>
            commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({
                level: 254,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('cmnd/tasmota_AABBCC/Dimmer', '100');
        await light.endpoint.act((agent) => commands(agent.get(OnOffServer)).off!({}));
        await expectPublished('cmnd/tasmota_AABBCC/POWER', 'OFF');
    });
});

describe('Shelly', () => {
    it('a cover: the position from JSON, a target through the set_position_template, stop', async () => {
        const cover = device(SHELLY_COVER);
        await publish('shellyplus2pm-d4e5f6/status/cover:0', JSON.stringify({state: 'stopped', current_pos: 30}));
        await waitFor(() => cover.state.windowCovering!.currentPositionLiftPercent100ths === 7000, 5000, 'position');
        published.length = 0;
        await cover.endpoint.act((agent) =>
            commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({liftPercent100thsValue: 2000}),
        );
        await expectPublished('shellyplus2pm-d4e5f6/command/cover:0', 'pos,80');
        await cover.endpoint.act((agent) => commands(agent.get(WindowCoveringServer)).stopMotion!({}));
        await expectPublished('shellyplus2pm-d4e5f6/command/cover:0', 'stop');
    });

    it('an event entity plays into its button', async () => {
        const i4 = device(SHELLY_I4);
        await publish(
            'shellyplusi4-778899/events/rpc',
            JSON.stringify({params: {events: [{component: 'input:0', event: 'double_push'}]}}),
        );
        await waitFor(() => i4.main.state.switch!.currentPosition === 1, 5000, 'pressed');
        await waitFor(() => i4.main.state.switch!.currentPosition === 0, 5000, 'released');
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
    });
});

describe("zigbee2mqtt's own discovery (json schema)", () => {
    it('the json light: one state topic, one coalesced set message', async () => {
        const light = device(HUE);
        await publish(
            'zigbee2mqtt/light_cellar_1',
            JSON.stringify({
                state: 'ON',
                brightness: 254,
                color_temp: 300,
                color_mode: 'color_temp',
                color: {x: 0.3, y: 0.3},
            }),
        );
        await waitFor(() => light.state.levelControl!.currentLevel === 254, 5000, 'level');
        expect(light.state.colorControl!.colorTemperatureMireds).toBe(300);
        published.length = 0;
        await light.endpoint.act((agent) =>
            commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({
                level: 127,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('zigbee2mqtt/light_cellar_1/set', '{"brightness":127,"state":"ON"}');
    });
});
