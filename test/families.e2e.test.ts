/* Every family against a real matter.js node and an in-process broker: status messages set the
   attributes the way the family means them, a controller's commands (the node's own interaction API)
   publish what the mappings say, and the state machines — colour mode arbitration, the cover's movement,
   fan consistency, switch events, battery levels, availability — behave. One App, many devices. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {
    ColorControlServer,
    DoorLockServer,
    LevelControlServer,
    OnOffServer,
    SwitchServer,
    WindowCoveringServer,
} from '../src/families/index.ts';
import {createLogger} from '../src/log.ts';
import type {DeviceHandle} from '../src/matter/bridge.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {freeUdpPort, settled, waitFor} from './helpers/util.ts';

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
let app: App;
const published: {topic: string; payload: string}[] = [];
const logLines: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function publish(topic: string, payload: string): Promise<void> {
    await observer.publishAsync(topic, payload);
}

async function expectPublished(
    topic: string,
    payload: string | ((p: string) => boolean),
    timeout = 5000,
): Promise<void> {
    await waitFor(
        () =>
            published.some(
                (p) => p.topic === topic && (typeof payload === 'string' ? p.payload === payload : payload(p.payload)),
            ),
        timeout,
        `${topic} ${typeof payload === 'string' ? payload : '(predicate)'}; got ${JSON.stringify(published)}`,
    );
}

function device(key: string): DeviceHandle {
    const handle = app.nodes.handle(key);
    if (handle === undefined) {
        throw new Error(`no device ${key}`);
    }
    return handle;
}

type Emitters = Record<string, Record<string, {emit(...args: unknown[]): void}>>;
/** the servers' command methods exist at runtime with the features; the family classes are typed without them */
type Commands = Record<string, (request: Record<string, unknown>) => Promise<void>>;
const commands = (behavior: unknown): Commands => behavior as Commands;

const config = () =>
    parseConfig({
        mqtt: {url: broker.url},
        storage,
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices: {
            scene: {
                name: 'Evening',
                endpoints: [
                    {
                        deviceTypes: ['OnOffPlugInUnit'],
                        options: {onOff: {momentary: 300}},
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                command: {topic: 'z/group/set', format: {true: '{"scene_recall":3}'}},
                            },
                        ],
                    },
                ],
            },
            light: {
                name: 'Light',
                availability: {topic: 'z/light/availability', extract: 'state', online: 'online', offline: 'offline'},
                endpoints: [
                    {
                        deviceTypes: ['ExtendedColorLight'],
                        coalesce: 30,
                        options: {light: {onCommandType: 'last', minMireds: 150, maxMireds: 500}},
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'z/light', extract: 'state', map: {ON: true, OFF: false}},
                                command: {topic: 'z/light/set', wrap: 'state', format: {true: 'ON', false: 'OFF'}},
                            },
                            {
                                attribute: 'LevelControl.currentLevel',
                                status: {topic: 'z/light', extract: 'brightness', unit: 'byteLevel'},
                                command: {topic: 'z/light/set', wrap: 'brightness', unit: 'byteLevel', round: 0},
                            },
                            {
                                attribute: 'ColorControl.colorTemperatureMireds',
                                status: {topic: 'z/light', extract: 'color_temp'},
                                command: {topic: 'z/light/set', wrap: 'color_temp'},
                            },
                            {
                                attribute: 'ColorControl.colorXy',
                                status: {topic: 'z/light', extract: 'color'},
                                command: {topic: 'z/light/set', wrap: 'color'},
                            },
                        ],
                    },
                ],
            },
            hsLight: {
                name: 'HS light',
                endpoints: [
                    {
                        deviceTypes: ['ExtendedColorLight'],
                        features: {ColorControl: ['HueSaturation']},
                        options: {light: {onCommandType: 'first'}},
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'stat/hs/RESULT', extract: 'POWER', map: {ON: true, OFF: false}},
                                command: {topic: 'cmnd/hs/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                            {
                                attribute: 'LevelControl.currentLevel',
                                status: {topic: 'stat/hs/RESULT', extract: 'Dimmer', unit: 'percentLevel'},
                                command: {topic: 'cmnd/hs/Dimmer', unit: 'percentLevel', round: 0},
                            },
                            {
                                attribute: 'ColorControl.colorRgb',
                                status: {topic: 'stat/hs/RESULT', extract: 'Color'},
                                command: {topic: 'cmnd/hs/Color', template: '{{ red }},{{ green }},{{ blue }}'},
                            },
                            {
                                attribute: 'ColorControl.colorTemperatureMireds',
                                status: {topic: 'stat/hs/RESULT', extract: 'CT'},
                                command: {topic: 'cmnd/hs/CT'},
                            },
                        ],
                    },
                ],
            },
            cover: {
                name: 'Cover',
                endpoints: [
                    {
                        deviceTypes: ['WindowCovering'],
                        options: {cover: {reportTimeout: 0.5, echoFilter: true}},
                        mappings: [
                            {
                                attribute: 'WindowCovering.currentPositionLiftPercent100ths',
                                status: {
                                    topic: 'z/cover',
                                    extract: 'position',
                                    scale: {from: [0, 100], to: [10000, 0]},
                                },
                            },
                            {
                                attribute: 'WindowCovering.targetPositionLiftPercent100ths',
                                command: {
                                    topic: 'z/cover/set',
                                    wrap: 'position',
                                    scale: {from: [0, 100], to: [10000, 0]},
                                    round: 0,
                                },
                            },
                            {
                                invoke: 'WindowCovering.stopMotion',
                                command: {topic: 'z/cover/set', wrap: 'state', payload: 'STOP'},
                            },
                        ],
                    },
                ],
            },
            stateCover: {
                name: 'State cover',
                endpoints: [
                    {
                        deviceTypes: ['WindowCovering'],
                        options: {cover: {reportTimeout: 0.3}},
                        mappings: [
                            {
                                attribute: 'WindowCovering.motion',
                                status: {
                                    topic: 'shelly/roller',
                                    map: {open: 'opening', close: 'closing', stop: 'stopped'},
                                },
                            },
                            {
                                invoke: 'WindowCovering.upOrOpen',
                                command: {topic: 'shelly/roller/command', payload: 'open'},
                            },
                            {
                                invoke: 'WindowCovering.downOrClose',
                                command: {topic: 'shelly/roller/command', payload: 'close'},
                            },
                            {
                                invoke: 'WindowCovering.stopMotion',
                                command: {topic: 'shelly/roller/command', payload: 'stop'},
                            },
                        ],
                    },
                ],
            },
            thermostat: {
                name: 'Thermostat',
                endpoints: [
                    {
                        deviceTypes: ['Thermostat'],
                        options: {climate: {minHeat: 5, maxHeat: 30}},
                        mappings: [
                            {
                                attribute: 'Thermostat.localTemperature',
                                status: {topic: 'z/trv', extract: 'local_temperature', unit: 'celsius'},
                            },
                            {
                                attribute: 'Thermostat.occupiedHeatingSetpoint',
                                status: {topic: 'z/trv', extract: 'current_heating_setpoint', unit: 'celsius'},
                                command: {
                                    topic: 'z/trv/set',
                                    wrap: 'current_heating_setpoint',
                                    unit: 'celsius',
                                    round: 1,
                                },
                            },
                            {
                                attribute: 'Thermostat.systemMode',
                                status: {topic: 'z/trv', extract: 'system_mode', map: {heat: 'Heat', off: 'Off'}},
                                command: {topic: 'z/trv/set', wrap: 'system_mode', format: {Heat: 'heat', Off: 'off'}},
                            },
                            {
                                attribute: 'Thermostat.thermostatRunningState',
                                status: {topic: 'z/trv', extract: 'running_state', map: {heat: 'heat', idle: ''}},
                            },
                        ],
                    },
                ],
            },
            lock: {
                name: 'Lock',
                endpoints: [
                    {
                        deviceTypes: ['DoorLock'],
                        mappings: [
                            {
                                attribute: 'DoorLock.lockState',
                                status: {
                                    topic: 'z/lock',
                                    extract: 'state',
                                    map: {LOCK: 'Locked', UNLOCK: 'Unlocked', JAMMED: 'NotFullyLocked'},
                                },
                                command: {
                                    topic: 'z/lock/set',
                                    wrap: 'state',
                                    format: {Locked: 'LOCK', Unlocked: 'UNLOCK'},
                                },
                            },
                        ],
                    },
                ],
            },
            fan: {
                name: 'Fan',
                endpoints: [
                    {
                        deviceTypes: ['Fan'],
                        mappings: [
                            {
                                attribute: 'FanControl.percentSetting',
                                status: {topic: 'fan/state', type: 'number'},
                                command: {topic: 'fan/set'},
                            },
                        ],
                    },
                ],
            },
            button: {
                name: 'Button',
                endpoints: [
                    {
                        deviceTypes: ['GenericSwitch'],
                        options: {switch: {multiPressDelay: 100, longPressDelay: 150, pressDuration: 20}},
                        mappings: [
                            {
                                event: 'Switch',
                                status: {
                                    topic: 'z/button',
                                    extract: 'action',
                                    map: {single: 'single', double: 'double', hold: 'long'},
                                },
                            },
                        ],
                    },
                    {
                        id: 'b2',
                        deviceTypes: ['GenericSwitch'],
                        options: {switch: {kind: 'latching'}},
                        mappings: [{event: 'Switch', status: {topic: 'z/button', extract: 'toggle', type: 'boolean'}}],
                    },
                ],
            },
            sensor: {
                name: 'Sensor',
                endpoints: [
                    {
                        deviceTypes: ['TemperatureSensor', 'PowerSource'],
                        options: {powerSource: {warning: 30, critical: 10}},
                        mappings: [
                            {
                                attribute: 'TemperatureMeasurement.measuredValue',
                                status: {topic: 'z/sensor', extract: 'temperature', unit: 'celsius', expire: 1},
                            },
                            {
                                attribute: 'PowerSource.batPercentRemaining',
                                status: {topic: 'z/sensor', extract: 'battery', unit: 'halfPercent'},
                            },
                            {
                                attribute: 'PowerSource.batVoltage',
                                status: {topic: 'z/sensor', extract: 'voltage', unit: 'volt'},
                            },
                        ],
                    },
                    {
                        id: 'humidity',
                        deviceTypes: ['HumiditySensor'],
                        mappings: [
                            {
                                attribute: 'RelativeHumidityMeasurement.measuredValue',
                                status: {topic: 'z/sensor', extract: 'humidity', unit: 'percent100ths'},
                            },
                        ],
                    },
                ],
            },
            contact: {
                name: 'Contact',
                endpoints: [
                    {
                        deviceTypes: ['ContactSensor'],
                        mappings: [
                            {
                                attribute: 'BooleanState.stateValue',
                                status: {topic: 'z/contact', extract: 'contact', type: 'boolean'},
                            },
                        ],
                    },
                ],
            },
            motion: {
                name: 'Motion',
                endpoints: [
                    {
                        deviceTypes: ['OccupancySensor', 'LightSensor'],
                        mappings: [
                            {
                                attribute: 'OccupancySensing.occupancy',
                                status: {topic: 'z/motion', extract: 'occupancy', type: 'boolean'},
                            },
                            {
                                attribute: 'IlluminanceMeasurement.measuredValue',
                                status: {topic: 'z/motion', extract: 'illuminance_lux', unit: 'lux'},
                            },
                        ],
                    },
                ],
            },
            air: {
                name: 'Air',
                endpoints: [
                    {
                        deviceTypes: ['AirQualitySensor'],
                        mappings: [
                            {
                                attribute: 'AirQuality.airQuality',
                                status: {
                                    topic: 'z/air',
                                    extract: 'air_quality',
                                    map: {
                                        excellent: 'Good',
                                        good: 'Good',
                                        moderate: 'Moderate',
                                        poor: 'Poor',
                                        unhealthy: 'VeryPoor',
                                    },
                                },
                            },
                            {
                                attribute: 'CarbonDioxideConcentrationMeasurement.measuredValue',
                                status: {topic: 'z/air', extract: 'co2'},
                            },
                            {
                                attribute: 'Pm25ConcentrationMeasurement.measuredValue',
                                status: {topic: 'z/air', extract: 'pm25'},
                            },
                        ],
                    },
                ],
            },
        },
    });

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-families-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync(['+/+/set', 'cmnd/#', 'shelly/#', 'fan/set']);
    observer.on('message', (topic, payload) => published.push({topic, payload: payload.toString()}));
    app = new App(config(), {mqttConnectTimeout: 5000, log: createLogger('warn', (line) => logLines.push(line))});
    await app.start();
}, 60_000);

afterAll(async () => {
    await app.stop();
    await observer.endAsync();
    await broker.close();
    await rm(storage, {recursive: true, force: true});
}, 60_000);

describe('the bridge', () => {
    it('builds every device without conformance violations or warnings', () => {
        const info = app.nodes.info()[0]!;
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
        expect(info.devices.map((d) => d.key).sort()).toEqual(
            [
                'air',
                'button',
                'contact',
                'cover',
                'fan',
                'hsLight',
                'light',
                'lock',
                'motion',
                'scene',
                'sensor',
                'stateCover',
                'thermostat',
            ].sort(),
        );
        expect(info.devices.every((d) => d.violations === 0)).toBe(true);
    });

    it('lists both device types and builds child endpoints under the device', () => {
        const sensor = device('sensor');
        expect(JSON.parse(JSON.stringify(sensor.state.descriptor!.deviceTypeList))).toEqual([
            {deviceType: 0x302, revision: expect.any(Number)},
            {deviceType: 0x11, revision: expect.any(Number)},
            {deviceType: 0x13, revision: expect.any(Number)},
        ]);
        const humidity = sensor.endpoints.get('humidity')!;
        expect(humidity.endpoint.id).toBe('sensor~humidity');
        expect(humidity.endpoint.owner).toBe(sensor.endpoint);
        expect(humidity.number).toBeGreaterThan(sensor.number!);
    });
});

describe('light', () => {
    it('status: level, colour temperature and xy with colour mode arbitration', async () => {
        const light = device('light');
        await publish('z/light', JSON.stringify({state: 'ON', brightness: 255, color_temp: 370}));
        await settled(() => {
            expect(light.state.levelControl!.currentLevel).toBe(254);
            expect(light.state.onOff!.onOff).toBe(true);
            expect(light.state.colorControl!.colorTemperatureMireds).toBe(370);
            expect(light.state.colorControl!.colorMode).toBe(2);
        });
        await publish('z/light', JSON.stringify({color: {x: 0.3, y: 0.6}}));
        await settled(() => {
            expect(light.state.colorControl!.currentX).toBe(Math.round(0.3 * 65535));
            expect(light.state.colorControl!.currentY).toBe(Math.round(0.6 * 65535));
            expect(light.state.colorControl!.colorMode).toBe(1);
        });
    });

    it('commands: level with on/off ordering, coalesced into one message', async () => {
        const light = device('light');
        published.length = 0;
        await publish('z/light', JSON.stringify({state: 'OFF', brightness: 10}));
        await settled(() => {
            expect(light.state.onOff!.onOff).toBe(false);
            expect(light.state.levelControl!.currentLevel).toBe(10);
        });
        await light.endpoint.act((agent) =>
            commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({
                level: 127,
                transitionTime: 10,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('z/light/set', '{"brightness":128,"state":"ON"}');
        // not optimistic: the attributes wait for the device's report
        expect(light.state.levelControl!.currentLevel).toBe(10);
        expect(light.state.onOff!.onOff).toBe(false);
        await publish('z/light', JSON.stringify({state: 'ON', brightness: 128}));
        await settled(() => {
            expect(light.state.onOff!.onOff).toBe(true);
            expect(light.state.levelControl!.currentLevel).toBe(127);
        });
    });

    it('commands: colour temperature and xy', async () => {
        const light = device('light');
        published.length = 0;
        await light.endpoint.act((agent) =>
            commands(agent.get(ColorControlServer)).moveToColorTemperature!({
                colorTemperatureMireds: 250,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('z/light/set', '{"color_temp":250}');
        await light.endpoint.act((agent) =>
            commands(agent.get(ColorControlServer)).moveToColor!({
                colorX: 32768,
                colorY: 19661,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('z/light/set', (p) => {
            const json = JSON.parse(p) as {color?: {x: number; y: number}};
            return (
                json.color !== undefined && Math.abs(json.color.x - 0.5) < 0.001 && Math.abs(json.color.y - 0.3) < 0.001
            );
        });
    });

    it('an RGB-only device: hue/saturation in, RGB out, on first', async () => {
        const light = device('hsLight');
        published.length = 0;
        await publish('stat/hs/RESULT', JSON.stringify({POWER: 'ON', Dimmer: 50, Color: '255,0,0'}));
        await settled(() => {
            expect(light.state.colorControl!.currentHue).toBe(0);
            expect(light.state.colorControl!.currentSaturation).toBe(254);
            expect(light.state.colorControl!.colorMode).toBe(0);
            expect(light.state.levelControl!.currentLevel).toBe(127);
        });
        await light.endpoint.act((agent) =>
            commands(agent.get(ColorControlServer)).moveToHueAndSaturation!({
                hue: 85,
                saturation: 254,
                transitionTime: 0,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('cmnd/hs/Color', (p) => {
            const [r, g, b] = p.split(',').map(Number);
            return r! < 10 && g! > 245 && b! < 10;
        });
        published.length = 0;
        await light.endpoint.act((agent) =>
            commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({
                level: 254,
                transitionTime: null,
                optionsMask: {},
                optionsOverride: {},
            }),
        );
        await expectPublished('cmnd/hs/Dimmer', '100');
        const order = published.map((p) => p.topic);
        expect(order.indexOf('cmnd/hs/POWER')).toBeLessThan(order.indexOf('cmnd/hs/Dimmer'));
        expect(published.find((p) => p.topic === 'cmnd/hs/POWER')?.payload).toBe('ON');
    });

    it('availability drives reachable', async () => {
        const light = device('light');
        await publish('z/light/availability', JSON.stringify({state: 'offline'}));
        await waitFor(() => light.state.bridgedDeviceBasicInformation!.reachable === false, 5000, 'unreachable');
        await publish('z/light/availability', JSON.stringify({state: 'online'}));
        await waitFor(() => light.state.bridgedDeviceBasicInformation!.reachable === true, 5000, 'reachable');
    });
});

describe('cover', () => {
    const wc = () => device('cover').state.windowCovering!;
    const status = () => (wc().operationalStatus as {lift: number}).lift;

    it('position reports set current and target; a controller target publishes and moves until reported', async () => {
        await publish('z/cover', JSON.stringify({position: 100}));
        await settled(() => {
            expect(wc().currentPositionLiftPercent100ths).toBe(0);
            expect(wc().targetPositionLiftPercent100ths).toBe(0);
        });
        published.length = 0;
        await device('cover').endpoint.act((agent) =>
            commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({liftPercent100thsValue: 5000}),
        );
        await expectPublished('z/cover/set', '{"position":50}');
        expect(wc().targetPositionLiftPercent100ths).toBe(5000);
        expect(status()).toBe(2); // closing
        // the echo: the old position repeated right after the command is held back
        await publish('z/cover', JSON.stringify({position: 100}));
        await sleep(100);
        expect(wc().currentPositionLiftPercent100ths).toBe(0);
        expect(status()).toBe(2);
        await publish('z/cover', JSON.stringify({position: 70}));
        await settled(() => {
            expect(wc().currentPositionLiftPercent100ths).toBe(3000);
            expect(status()).toBe(2);
        });
        await publish('z/cover', JSON.stringify({position: 50}));
        await settled(() => {
            expect(status()).toBe(0);
            expect(wc().currentPositionLiftPercent100ths).toBe(5000);
            expect(wc().targetPositionLiftPercent100ths).toBe(5000);
        });
    });

    it('an external move predicts the target and ends with the report timeout', async () => {
        await publish('z/cover', JSON.stringify({position: 40}));
        await settled(() => {
            expect(wc().currentPositionLiftPercent100ths).toBe(6000);
            expect(wc().targetPositionLiftPercent100ths).toBe(10000);
            expect(status()).toBe(2);
        });
        await settled(() => {
            expect(status()).toBe(0);
            expect(wc().targetPositionLiftPercent100ths).toBe(6000);
        });
    });

    it('stop publishes the command mapping and snaps the target', async () => {
        published.length = 0;
        await device('cover').endpoint.act((agent) =>
            commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({liftPercent100thsValue: 0}),
        );
        await expectPublished('z/cover/set', '{"position":100}');
        await device('cover').endpoint.act((agent) => agent.get(WindowCoveringServer).stopMotion());
        await expectPublished('z/cover/set', '{"state":"STOP"}');
        await settled(() => {
            expect(status()).toBe(0);
            expect(wc().targetPositionLiftPercent100ths).toBe(6000);
        });
    });

    it('a state-only cover: up/down/stop commands and motion reports', async () => {
        const cover = device('stateCover');
        const state = () => (cover.state.windowCovering!.operationalStatus as {lift: number}).lift;
        published.length = 0;
        await cover.endpoint.act((agent) => agent.get(WindowCoveringServer).downOrClose());
        await expectPublished('shelly/roller/command', 'close');
        await publish('shelly/roller', 'close');
        await waitFor(() => state() === 2, 5000, 'closing');
        await publish('shelly/roller', 'stop');
        await waitFor(() => state() === 0, 5000, 'stopped');
        await cover.endpoint.act((agent) => agent.get(WindowCoveringServer).upOrOpen());
        await expectPublished('shelly/roller/command', 'open');
        await publish('shelly/roller', 'open');
        await waitFor(() => state() === 1, 5000, 'opening');
        // nobody reports the stop: the report timeout ends it
        await waitFor(() => state() === 0, 5000, 'timeout');
    });
});

describe('thermostat', () => {
    it('status: temperature, setpoint, mode, running state', async () => {
        const trv = device('thermostat');
        await publish(
            'z/trv',
            JSON.stringify({
                local_temperature: 21.5,
                current_heating_setpoint: 22,
                system_mode: 'heat',
                running_state: 'heat',
            }),
        );
        await settled(() => {
            expect(trv.state.thermostat!.localTemperature).toBe(2150);
            expect(trv.state.thermostat!.occupiedHeatingSetpoint).toBe(2200);
            expect(trv.state.thermostat!.systemMode).toBe(4);
            expect(trv.state.thermostat!.thermostatRunningState).toMatchObject({heat: true});
        });
        await publish('z/trv', JSON.stringify({running_state: 'idle', system_mode: 'off'}));
        await settled(() => {
            expect(trv.state.thermostat!.systemMode).toBe(0);
            expect((trv.state.thermostat!.thermostatRunningState as {heat?: boolean}).heat).not.toBe(true);
        });
    });

    it("a controller's write is applied by matter.js and published from the change", async () => {
        const trv = device('thermostat');
        published.length = 0;
        await trv.endpoint.set({thermostat: {occupiedHeatingSetpoint: 2050, systemMode: 4}} as never);
        expect(trv.state.thermostat!.occupiedHeatingSetpoint).toBe(2050);
        await sleep(50);
        // an offline (local) change is not a controller's write: nothing published
        expect(published).toEqual([]);
        const events = (trv.endpoint.events as unknown as Emitters).thermostat!;
        events.occupiedHeatingSetpoint$Changed!.emit(2050, 2000, {offline: false});
        events.systemMode$Changed!.emit(4, 0, {offline: false});
        await expectPublished('z/trv/set', '{"current_heating_setpoint":20.5}');
        await expectPublished('z/trv/set', '{"system_mode":"heat"}');
    });
});

describe('lock', () => {
    it('lock/unlock publish by state name and wait for the report; jammed maps to NotFullyLocked', async () => {
        const lock = device('lock');
        published.length = 0;
        await lock.endpoint.act((agent) => agent.get(DoorLockServer).lockDoor({}));
        await expectPublished('z/lock/set', '{"state":"LOCK"}');
        expect(lock.state.doorLock!.lockState).toBe(2);
        await publish('z/lock', JSON.stringify({state: 'LOCK'}));
        await waitFor(() => lock.state.doorLock!.lockState === 1, 5000, 'locked');
        await lock.endpoint.act((agent) => agent.get(DoorLockServer).unlockDoor({}));
        await expectPublished('z/lock/set', '{"state":"UNLOCK"}');
        await publish('z/lock', JSON.stringify({state: 'JAMMED'}));
        await waitFor(() => lock.state.doorLock!.lockState === 0, 5000, 'jammed');
    });
});

describe('fan', () => {
    it('a percent report sets setting, current and mode; a mode write publishes the percent', async () => {
        const fan = device('fan');
        await publish('fan/state', '50');
        await settled(() => {
            expect(fan.state.fanControl!.percentCurrent).toBe(50);
            expect(fan.state.fanControl!.percentSetting).toBe(50);
            expect(fan.state.fanControl!.fanMode).toBe(2);
        });
        published.length = 0;
        const events = (fan.endpoint.events as unknown as Emitters).fanControl!;
        await fan.endpoint.set({fanControl: {fanMode: 3}} as never);
        events.fanMode$Changed!.emit(3, 2, {offline: false});
        await expectPublished('fan/set', '100');
        await waitFor(() => fan.state.fanControl!.percentSetting === 100, 5000, 'percent from mode');
        await fan.endpoint.set({fanControl: {percentSetting: 20}} as never);
        events.percentSetting$Changed!.emit(20, 100, {offline: false});
        await expectPublished('fan/set', '20');
        await settled(() => {
            expect(fan.state.fanControl!.fanMode).toBe(1);
            expect(fan.state.fanControl!.percentCurrent).toBe(20);
        });
    });
});

describe('switch', () => {
    function record(endpointKey: string, endpointId = 'main'): string[] {
        const seen: string[] = [];
        const events = device(endpointKey).endpoints.get(endpointId)!.endpoint.events as unknown as Record<
            string,
            Record<string, {on(fn: (payload: unknown) => void): void}>
        >;
        for (const name of [
            'initialPress',
            'shortRelease',
            'longPress',
            'longRelease',
            'multiPressOngoing',
            'multiPressComplete',
            'switchLatched',
        ]) {
            events.switch![name]?.on((payload) => seen.push(`${name}${JSON.stringify(payload)}`));
        }
        return seen;
    }

    it('plays single, double and long presses into GenericSwitch events', async () => {
        const seen = record('button');
        await publish('z/button', JSON.stringify({action: 'single'}));
        await waitFor(
            () => seen.some((e) => e.startsWith('multiPressComplete')),
            5000,
            `single; got ${seen.join(' ')}`,
        );
        expect(seen).toEqual([
            'initialPress{"newPosition":1}',
            'shortRelease{"previousPosition":1}',
            'multiPressComplete{"previousPosition":1,"totalNumberOfPressesCounted":1}',
        ]);
        seen.length = 0;
        await publish('z/button', JSON.stringify({action: 'double'}));
        await waitFor(
            () => seen.some((e) => e.startsWith('multiPressComplete')),
            5000,
            `double; got ${seen.join(' ')}`,
        );
        expect(seen).toEqual([
            'initialPress{"newPosition":1}',
            'shortRelease{"previousPosition":1}',
            'initialPress{"newPosition":1}',
            'multiPressOngoing{"newPosition":1,"currentNumberOfPressesCounted":2}',
            'shortRelease{"previousPosition":1}',
            'multiPressComplete{"previousPosition":1,"totalNumberOfPressesCounted":2}',
        ]);
        seen.length = 0;
        await publish('z/button', JSON.stringify({action: 'hold'}));
        await waitFor(() => seen.some((e) => e.startsWith('longRelease')), 5000, `long; got ${seen.join(' ')}`);
        expect(seen).toEqual([
            'initialPress{"newPosition":1}',
            'longPress{"newPosition":1}',
            'longRelease{"previousPosition":1}',
        ]);
        await settled(() => {
            expect(device('button').state.switch!.currentPosition).toBe(0);
        });
    });

    it('a latching switch takes the value as its position', async () => {
        const seen = record('button', 'b2');
        await publish('z/button', JSON.stringify({toggle: true}));
        await settled(() => {
            expect(device('button').endpoints.get('b2')!.state.switch!.currentPosition).toBe(1);
            expect(seen).toEqual(['switchLatched{"newPosition":1}']);
        });
    });
});

describe('sensors and power source', () => {
    it('temperature, humidity on the child, battery with derived charge level, voltage', async () => {
        const sensor = device('sensor');
        await publish('z/sensor', JSON.stringify({temperature: 21.45, humidity: 55.5, battery: 25, voltage: 2.9}));
        await settled(() => {
            expect(sensor.state.temperatureMeasurement!.measuredValue).toBe(2145);
            expect(sensor.endpoints.get('humidity')!.state.relativeHumidityMeasurement!.measuredValue).toBe(5550);
            expect(sensor.state.powerSource!.batPercentRemaining).toBe(50);
            expect(sensor.state.powerSource!.batChargeLevel).toBe(1);
            expect(sensor.state.powerSource!.batVoltage).toBe(2900);
        });
        await publish('z/sensor', JSON.stringify({battery: 5}));
        await waitFor(() => sensor.state.powerSource!.batChargeLevel === 2, 5000, 'critical');
    });

    it('expire turns the device unreachable until the next message', async () => {
        const sensor = device('sensor');
        await waitFor(() => sensor.state.bridgedDeviceBasicInformation!.reachable === false, 5000, 'expired');
        await publish('z/sensor', JSON.stringify({temperature: 20}));
        await waitFor(() => sensor.state.bridgedDeviceBasicInformation!.reachable === true, 5000, 'back');
    });

    it('contact, occupancy bitmap, lux, air quality and concentrations', async () => {
        await publish('z/contact', JSON.stringify({contact: false}));
        await waitFor(() => device('contact').state.booleanState!.stateValue === false, 5000, 'contact');
        await publish('z/motion', JSON.stringify({occupancy: true, illuminance_lux: 100}));
        await settled(() => {
            expect(device('motion').state.occupancySensing!.occupancy).toMatchObject({occupied: true});
            expect(device('motion').state.illuminanceMeasurement!.measuredValue).toBe(20001);
        });
        await publish('z/air', JSON.stringify({air_quality: 'poor', co2: 812, pm25: 7.5}));
        await settled(() => {
            expect(device('air').state.airQuality!.airQuality).toBe(4);
            expect(device('air').state.carbonDioxideConcentrationMeasurement!.measuredValue).toBe(812);
            expect(device('air').state.pm25ConcentrationMeasurement!.measuredValue).toBe(7.5);
        });
    });
});

describe('a momentary on/off (a scene)', () => {
    it('on publishes the recall and falls back to off; off publishes nothing', async () => {
        const scene = device('scene');
        published.length = 0;
        await scene.endpoint.act((agent) => agent.get(OnOffServer).on());
        await expectPublished('z/group/set', '{"scene_recall":3}');
        expect(scene.state.onOff!.onOff).toBe(true);
        await waitFor(() => scene.state.onOff!.onOff === false, 3000, 'back to off');
        expect(published.filter((p) => p.topic === 'z/group/set')).toHaveLength(1);

        // a second press while on restarts the time, an off in between only switches it off locally
        await scene.endpoint.act((agent) => agent.get(OnOffServer).on());
        await scene.endpoint.act((agent) => agent.get(OnOffServer).off());
        expect(scene.state.onOff!.onOff).toBe(false);
        await sleep(400);
        expect(published.filter((p) => p.topic === 'z/group/set')).toHaveLength(2);
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
    });
});

describe('on/off without a family option', () => {
    it('still routes through the OnOff family', async () => {
        const light = device('light');
        published.length = 0;
        await light.endpoint.act((agent) => agent.get(OnOffServer).off());
        await expectPublished('z/light/set', '{"state":"OFF"}');
    });

    it('the switch family keeps its own server', () => {
        expect(device('button').endpoint.behaviors.has(SwitchServer)).toBe(true);
    });
});
