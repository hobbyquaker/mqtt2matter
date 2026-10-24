/* The Zigbee2MQTT generator over the 35-device corpus (`test/fixtures/z2m/`, matterbridge-zigbee2mqtt's
   `src/mock/bridge-devices.json` and `bridge-groups.json` at commit c72dd312, Apache-2.0 — see NOTICE)
   and over hand-written descriptions of devices the corpus lacks: expected device types, clusters,
   features and mappings per device; every baseline parses, validates and passes the strict dry run. */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {z2m} from '../src/importers/index.ts';
import {checkConfig, formatCheck} from '../src/matter/check.ts';
import {type MappingInput, type DeviceInput, DeviceSchema, validateDevice} from '../src/model/index.ts';

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');
const devices = z2m.parseBridgeDevices(readFileSync(join(fixtures, 'bridge-devices.json')));
const groups = z2m.parseBridgeGroups(readFileSync(join(fixtures, 'bridge-groups.json')));
const discovery = z2m.discover({devices, groups});
const byKey = new Map(discovery.items.map((item) => [item.key, item]));

function baseline(key: string): DeviceInput {
    const item = byKey.get(key);
    if (item?.baseline === undefined) {
        throw new Error(`${key}: ${item?.reason ?? 'not discovered'}`);
    }
    return item.baseline;
}

const target = (b: MappingInput): string => ('attribute' in b ? b.attribute : 'invoke' in b ? b.invoke : b.event);
const mapping = (device: DeviceInput, name: string, endpoint = 'main'): MappingInput => {
    const ep = device.endpoints.find((e) => (e.id ?? 'main') === endpoint);
    const found = ep?.mappings?.find((b) => target(b) === name);
    if (found === undefined) {
        throw new Error(`${device.name}: no ${name} on ${endpoint}`);
    }
    return found;
};
const types = (device: DeviceInput): Record<string, string[]> =>
    Object.fromEntries(device.endpoints.map((e) => [e.id ?? 'main', e.deviceTypes]));

describe('the corpus', () => {
    it('discovers 35 devices and 10 groups; the coordinator and the empty groups are unsupported', () => {
        expect(discovery.items).toHaveLength(45);
        expect(discovery.sawDevices && discovery.sawGroups).toBe(true);
        const unsupported = discovery.items.filter((i) => !i.supported).map((i) => [i.key, i.reason]);
        expect(unsupported).toEqual([
            ['z2m:0x00124b0025e1f196', 'the coordinator'],
            ['z2m:group:1', 'no members'],
            ['z2m:group:2', 'no members'],
            ['z2m:group:3', 'no members'],
            ['z2m:group:4', 'no members'],
            ['z2m:group:5', 'no members'],
            ['z2m:group:6', 'no members'],
        ]);
    });

    it('every baseline parses and validates statically', () => {
        for (const item of discovery.items) {
            if (item.baseline === undefined) {
                continue;
            }
            const parsed = DeviceSchema.safeParse(item.baseline);
            expect(parsed.success, `${item.key} ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
            if (parsed.success) {
                const result = validateDevice(parsed.data);
                expect(result.errors, `${item.key} ${JSON.stringify(result.errors)}`).toEqual([]);
            }
        }
    });

    it('every baseline passes the strict matter.js dry run', async () => {
        const {devices: adopted} = z2m.adopt({}, discovery);
        expect(Object.keys(adopted)).toHaveLength(38);
        const result = await checkConfig(parseConfig({log: {matter: 'error'}, devices: adopted}));
        expect(formatCheck(result).filter((l) => l.startsWith('ERROR'))).toEqual([]);
        expect(result.ok).toBe(true);
    }, 60_000);

    it('a climate sensor: three measurements and the battery on one endpoint', () => {
        const device = baseline('z2m:0x00158d000945f2b1');
        expect(device).toMatchObject({
            name: 'Climate sensor',
            vendor: 'Aqara',
            model: 'WSDCGQ11LM',
            serial: '0x00158d000945f2b1',
            source: {kind: 'z2m', key: '0x00158d000945f2b1'},
            availability: {topic: 'zigbee2mqtt/Climate sensor/availability', template: z2m.AVAILABILITY_TEMPLATE},
        });
        expect(types(device)).toEqual({main: ['TemperatureSensor', 'HumiditySensor', 'PressureSensor', 'PowerSource']});
        expect(mapping(device, 'TemperatureMeasurement.measuredValue')).toEqual({
            attribute: 'TemperatureMeasurement.measuredValue',
            status: {topic: 'zigbee2mqtt/Climate sensor', extract: 'temperature', unit: 'celsius'},
        });
        expect(mapping(device, 'RelativeHumidityMeasurement.measuredValue').status).toMatchObject({
            extract: 'humidity',
            unit: 'percent100ths',
        });
        expect(mapping(device, 'PressureMeasurement.measuredValue').status).toMatchObject({
            extract: 'pressure',
            round: 0,
        });
        expect(mapping(device, 'PowerSource.batPercentRemaining').status).toMatchObject({
            extract: 'battery',
            unit: 'halfPercent',
        });
        // the voltage is in mV already
        expect(mapping(device, 'PowerSource.batVoltage').status).toEqual({
            topic: 'zigbee2mqtt/Climate sensor',
            extract: 'voltage',
            round: 0,
        });
        expect(byKey.get('z2m:0x00158d000945f2b1')!.unmapped).toEqual(['linkquality']);
    });

    it('a contact sensor: zigbee2mqtt reports the open contact as its "on"', () => {
        const device = baseline('z2m:0x00158d00091e7bd6');
        expect(types(device)).toEqual({main: ['ContactSensor', 'PowerSource']});
        expect(mapping(device, 'BooleanState.stateValue').status).toMatchObject({
            extract: 'contact',
            map: {false: false, true: true},
        });
    });

    it('an occupancy sensor with illuminance: two sensor types, the lux expose chosen once', () => {
        const device = baseline('z2m:0x00158d0007e778c1');
        expect(types(device)).toEqual({main: ['OccupancySensor', 'LightSensor', 'PowerSource']});
        expect(mapping(device, 'OccupancySensing.occupancy').status).toMatchObject({
            extract: 'occupancy',
            map: {true: true, false: false},
        });
        expect(mapping(device, 'IlluminanceMeasurement.measuredValue').status).toMatchObject({
            extract: 'illuminance',
            unit: 'lux',
        });
        expect(
            device.endpoints[0]!.mappings!.filter((b) => target(b) === 'IlluminanceMeasurement.measuredValue'),
        ).toHaveLength(1);
    });

    it('a two-channel relay with per-channel actions: child endpoints with number tags', () => {
        const device = baseline('z2m:0x54ef4410009716a8');
        expect(types(device)).toEqual({
            main: ['OnOffPlugInUnit'],
            l2: ['OnOffPlugInUnit'],
            button_l1: ['GenericSwitch'],
            button_l2: ['GenericSwitch'],
        });
        expect(mapping(device, 'OnOff.onOff')).toEqual({
            attribute: 'OnOff.onOff',
            status: {
                topic: 'zigbee2mqtt/Aqara Dual relay module T2',
                extract: 'state_l1',
                map: {ON: true, OFF: false},
                get: {topic: 'zigbee2mqtt/Aqara Dual relay module T2/get', payload: '{"state_l1":""}'},
            },
            command: {
                topic: 'zigbee2mqtt/Aqara Dual relay module T2/set',
                wrap: 'state_l1',
                format: {true: 'ON', false: 'OFF'},
            },
        });
        expect(mapping(device, 'OnOff.onOff', 'l2').status).toMatchObject({extract: 'state_l2'});
        expect(mapping(device, 'Switch', 'button_l1').status).toMatchObject({
            extract: 'action',
            map: {single_l1: 'single'},
        });
        expect(mapping(device, 'Switch', 'button_l2').status).toMatchObject({map: {single_l2: 'single'}});
        const l2 = device.endpoints.find((e) => e.id === 'l2')!;
        expect(l2.features).toEqual({Descriptor: ['TagList']});
        expect(l2.attributes).toEqual({Descriptor: {tagList: [{mfgCode: null, namespaceId: 7, tag: 1, label: 'l2'}]}});
        expect(device.endpoints.find((e) => e.id === 'button_l2')!.attributes).toEqual({
            Descriptor: {tagList: [{mfgCode: null, namespaceId: 7, tag: 3, label: 'button_l2'}]},
        });
    });

    it('a position-aware cover with a moving report', () => {
        const device = baseline('z2m:0x70ac08fffee6dd5e');
        expect(types(device)).toEqual({main: ['WindowCovering']});
        const scale = {from: [0, 100], to: [10000, 0]};
        expect(mapping(device, 'WindowCovering.currentPositionLiftPercent100ths').status).toEqual({
            topic: 'zigbee2mqtt/Window shutter',
            extract: 'position',
            scale,
            get: {topic: 'zigbee2mqtt/Window shutter/get', payload: '{"position":""}'},
        });
        expect(mapping(device, 'WindowCovering.targetPositionLiftPercent100ths')).toEqual({
            attribute: 'WindowCovering.targetPositionLiftPercent100ths',
            command: {topic: 'zigbee2mqtt/Window shutter/set', wrap: 'position', scale, round: 0},
        });
        expect(mapping(device, 'WindowCovering.stopMotion').command).toEqual({
            topic: 'zigbee2mqtt/Window shutter/set',
            wrap: 'state',
            payload: 'STOP',
        });
        expect(mapping(device, 'WindowCovering.motion').status).toMatchObject({
            extract: 'moving',
            map: {UP: 'opening', STOP: 'stopped', DOWN: 'closing'},
        });
        expect(device.endpoints[0]!.mappings!.map(target)).not.toContain('WindowCovering.upOrOpen');
        expect(byKey.get('z2m:0x70ac08fffee6dd5e')!.unmapped).toEqual([
            'calibration_time',
            'motor_reversal',
            'linkquality',
        ]);
    });

    it('a button: press kinds and the most presses it announces', () => {
        const device = baseline('z2m:0x00158d0008066798');
        expect(types(device)).toEqual({main: ['GenericSwitch', 'PowerSource']});
        expect(mapping(device, 'Switch')).toEqual({
            event: 'Switch',
            status: {
                topic: 'zigbee2mqtt/Scenes button',
                extract: 'action',
                map: {
                    single: 'single',
                    double: 'double',
                    triple: 'triple',
                    quadruple: 'quadruple',
                    hold: 'long',
                    release: 'longRelease',
                },
            },
        });
        expect(device.endpoints[0]!.options).toEqual({switch: {multiPressMax: 4}});
    });

    it('a thermostat: setpoint limits, modes by name, the child lock skipped', () => {
        const device = baseline('z2m:0xa4c138f402dfba8a');
        expect(types(device)).toEqual({main: ['Thermostat']});
        expect(device.endpoints[0]!.options).toEqual({climate: {minHeat: 5, maxHeat: 45}});
        expect(device.endpoints[0]!.coalesce).toBe(50);
        expect(mapping(device, 'Thermostat.localTemperature').status).toMatchObject({
            extract: 'local_temperature',
            unit: 'celsius',
        });
        expect(mapping(device, 'Thermostat.occupiedHeatingSetpoint')).toEqual({
            attribute: 'Thermostat.occupiedHeatingSetpoint',
            status: {topic: 'zigbee2mqtt/Moes thermo', extract: 'current_heating_setpoint', unit: 'celsius'},
            command: {
                topic: 'zigbee2mqtt/Moes thermo/set',
                wrap: 'current_heating_setpoint',
                unit: 'celsius',
                round: 1,
            },
        });
        expect(mapping(device, 'Thermostat.systemMode')).toMatchObject({
            status: {map: {off: 'Off', heat: 'Heat'}},
            command: {format: {Off: 'off', Heat: 'heat'}},
        });
        expect(mapping(device, 'Thermostat.thermostatRunningState').status).toMatchObject({
            map: {idle: '', heat: 'heat', cool: 'cool'},
        });
        const unmapped = byKey.get('z2m:0xa4c138f402dfba8a')!.unmapped;
        expect(unmapped).toContain('child_lock');
        expect(unmapped).toContain('preset');
        expect(unmapped).toContain('program');
        expect(device.endpoints[0]!.mappings!.map(target)).not.toContain('DoorLock.lockState');
    });

    it('an extended colour light: xy with hue/saturation as a feature, colour mode bound, mireds range', () => {
        const device = baseline('z2m:0xa4c138071003495f');
        expect(types(device)).toEqual({main: ['ExtendedColorLight']});
        const main = device.endpoints[0]!;
        expect(main.coalesce).toBe(50);
        expect(main.features).toEqual({ColorControl: ['HueSaturation']});
        expect(main.options).toEqual({light: {minMireds: 158, maxMireds: 495}});
        expect(mapping(device, 'OnOff.onOff').status).toMatchObject({
            get: {topic: 'zigbee2mqtt/Gledopto RGBCTT light I/get', payload: '{"state":""}'},
        });
        expect(mapping(device, 'LevelControl.currentLevel')).toMatchObject({
            status: {extract: 'brightness', scale: {from: [1, 254], to: [1, 254]}},
            command: {wrap: 'brightness', scale: {from: [1, 254], to: [1, 254]}, round: 0},
        });
        expect(mapping(device, 'ColorControl.colorTemperatureMireds')).toMatchObject({
            status: {extract: 'color_temp'},
            command: {wrap: 'color_temp'},
        });
        expect(mapping(device, 'ColorControl.colorXy')).toMatchObject({
            status: {extract: 'color'},
            command: {wrap: 'color'},
        });
        expect(mapping(device, 'ColorControl.colorMode').status).toMatchObject({
            extract: 'color_mode',
            map: {
                xy: 'CurrentXAndCurrentY',
                hs: 'CurrentHueAndCurrentSaturation',
                color_temp: 'ColorTemperatureMireds',
            },
        });
        expect(main.mappings!.map(target)).not.toContain('ColorControl.colorHs');
        // only one `/get` per endpoint
        expect(main.mappings!.filter((b) => b.status?.get !== undefined)).toHaveLength(1);
    });

    it('a two-channel dimmer: the first channel is the device, the second a tagged child', () => {
        const device = baseline('z2m:0x847127fffeaff50a');
        expect(types(device)).toEqual({main: ['DimmableLight'], l2: ['DimmableLight']});
        expect(mapping(device, 'OnOff.onOff').status).toMatchObject({extract: 'state_l1'});
        expect(mapping(device, 'OnOff.onOff').status!.get).toBeUndefined();
        expect(mapping(device, 'LevelControl.currentLevel', 'l2').status).toMatchObject({extract: 'brightness_l2'});
        expect(device.endpoints[1]!.attributes).toEqual({
            Descriptor: {tagList: [{mfgCode: null, namespaceId: 7, tag: 1, label: 'l2'}]},
        });
    });

    it('air quality: the enum by name, VOC in µg/m³ left out', () => {
        const device = baseline('z2m:0x0015bc0036001b9e');
        expect(types(device)).toEqual({
            main: ['AirQualitySensor', 'TemperatureSensor', 'HumiditySensor', 'PowerSource'],
        });
        expect(mapping(device, 'AirQuality.airQuality').status).toMatchObject({
            map: {
                excellent: 'Good',
                good: 'Fair',
                moderate: 'Moderate',
                poor: 'Poor',
                unhealthy: 'VeryPoor',
                out_of_range: 'Unknown',
                unknown: 'Unknown',
            },
        });
        expect(byKey.get('z2m:0x0015bc0036001b9e')!.unmapped).toEqual(['voc', 'linkquality']);
    });

    it('a CO sensor: the alarm state and the concentration', () => {
        const device = baseline('z2m:0xa4c138636c5c666e');
        expect(types(device)).toEqual({main: ['SmokeCoAlarm', 'AirQualitySensor', 'PowerSource']});
        expect(device.endpoints[0]!.features).toEqual({SmokeCoAlarm: ['CoAlarm']});
        expect(mapping(device, 'SmokeCoAlarm.coState').status).toMatchObject({
            extract: 'carbon_monoxide',
            map: {true: 'Critical', false: 'Normal'},
        });
        expect(mapping(device, 'CarbonMonoxideConcentrationMeasurement.measuredValue').status).toMatchObject({
            extract: 'co',
        });
    });

    it('a remote with press kinds and bare actions: continuous actions left out', () => {
        const device = baseline('z2m:0x385b44fffe20cfb2');
        expect(types(device)).toEqual({
            main: ['GenericSwitch', 'PowerSource'],
            button_on: ['GenericSwitch'],
            button_off: ['GenericSwitch'],
        });
        expect(mapping(device, 'Switch').status).toMatchObject({
            map: {single: 'single', double: 'double', hold: 'long'},
        });
        expect(mapping(device, 'Switch', 'button_on').status).toMatchObject({map: {on: 'single'}});
        expect(mapping(device, 'Switch', 'button_off').status).toMatchObject({map: {off: 'single'}});
        expect(byKey.get('z2m:0x385b44fffe20cfb2')!.unmapped).toEqual([
            'action:brightness_move_to_level',
            'action:color_temperature_move',
            'action:brightness_step_up',
            'action:brightness_step_down',
            'operation_mode',
            'linkquality',
        ]);
    });

    it('groups: the union of the members', () => {
        const lights = baseline('z2m:group:7');
        expect(lights).toMatchObject({
            name: 'Lights',
            vendor: 'Zigbee2MQTT',
            model: 'Group',
            serial: 'group-7',
            source: {kind: 'z2m', key: 'group:7'},
        });
        expect(lights.availability).toBeUndefined();
        expect(types(lights)).toEqual({main: ['ExtendedColorLight']});
        expect(lights.endpoints[0]!.options).toEqual({light: {minMireds: 153, maxMireds: 555}});
        expect(lights.endpoints[0]!.features).toEqual({ColorControl: ['HueSaturation']});
        expect(mapping(lights, 'OnOff.onOff')).toEqual({
            attribute: 'OnOff.onOff',
            status: {topic: 'zigbee2mqtt/Lights', extract: 'state', map: {ON: true, OFF: false}},
            command: {topic: 'zigbee2mqtt/Lights/set', wrap: 'state', format: {true: 'ON', false: 'OFF'}},
        });
        expect(types(baseline('z2m:group:8'))).toEqual({main: ['OnOffPlugInUnit']});
        const covers = baseline('z2m:group:9');
        expect(types(covers)).toEqual({main: ['WindowCovering']});
        expect(covers.endpoints[0]!.mappings!.map(target)).toEqual([
            'WindowCovering.currentPositionLiftPercent100ths',
            'WindowCovering.targetPositionLiftPercent100ths',
            'WindowCovering.stopMotion',
        ]);
        const raw = lights.source!.raw as z2m.RawGroup;
        expect(raw.union).toMatchObject({kind: 'light', brightness: true, xy: true, hs: true, members: 6});
    });

    it('the raw description regenerates the same baseline', () => {
        for (const item of discovery.items) {
            if (item.baseline === undefined) {
                continue;
            }
            const raw = item.baseline.source!.raw as z2m.Raw;
            expect(z2m.generate(raw)!.device).toEqual(item.baseline);
            expect(item.baseline.source!.version).toBe(z2m.rawHash(raw));
        }
    });
});

/* devices the corpus lacks, described the way zigbee2mqtt publishes them */
const device = (model: string, exposes: z2m.Expose[], extra: Partial<z2m.BridgeDevice> = {}): z2m.BridgeDevice => ({
    ieee_address: '0x0000000000000001',
    friendly_name: 'Test',
    type: 'EndDevice',
    supported: true,
    interview_completed: true,
    definition: {vendor: 'Vendor', model, exposes},
    ...extra,
});
const generateOne = (d: z2m.BridgeDevice): z2m.Generated => {
    const generated = z2m.generateDevice(z2m.rawDevice(d, 'z'));
    if (generated === undefined) {
        throw new Error('nothing generated');
    }
    return generated;
};

describe('hand-written descriptions', () => {
    it('a blind that echoes its target: the echo filter from the model quirks', () => {
        const cover = {
            type: 'cover',
            features: [
                {type: 'enum', name: 'state', property: 'state', access: 3, values: ['OPEN', 'CLOSE', 'STOP']},
                {
                    type: 'numeric',
                    name: 'position',
                    property: 'position',
                    access: 7,
                    value_min: 0,
                    value_max: 100,
                    unit: '%',
                },
            ],
        };
        const battery = {type: 'numeric', name: 'battery', property: 'battery', access: 5, unit: '%'};
        const fyrtur = generateOne(device('E1757', [cover, battery], {power_source: 'Battery'})).device;
        expect(types(fyrtur)).toEqual({main: ['WindowCovering', 'PowerSource']});
        expect(fyrtur.endpoints[0]!.options).toEqual({cover: {echoFilter: true}});
        // without a movement report there is no motion mapping on a position-aware cover
        expect(fyrtur.endpoints[0]!.mappings!.map(target)).toEqual([
            'WindowCovering.currentPositionLiftPercent100ths',
            'WindowCovering.targetPositionLiftPercent100ths',
            'WindowCovering.stopMotion',
            'PowerSource.batPercentRemaining',
        ]);
        const other = generateOne(device('TS130F', [cover])).device;
        expect(other.endpoints[0]!.options).toBeUndefined();
    });

    it('a state-only cover: motion from the state, open/close/stop commands', () => {
        const generated = generateOne(
            device('shutter', [
                {
                    type: 'cover',
                    features: [
                        {type: 'enum', name: 'state', property: 'state', access: 3, values: ['OPEN', 'CLOSE', 'STOP']},
                    ],
                },
            ]),
        );
        const main = generated.device.endpoints[0]!;
        expect(main.mappings!.map(target)).toEqual([
            'WindowCovering.upOrOpen',
            'WindowCovering.downOrClose',
            'WindowCovering.stopMotion',
            'WindowCovering.motion',
        ]);
        expect(mapping(generated.device, 'WindowCovering.motion').status).toMatchObject({
            extract: 'state',
            map: {OPEN: 'open', CLOSE: 'closed', STOP: 'stopped'},
        });
        expect(mapping(generated.device, 'WindowCovering.downOrClose').command).toEqual({
            topic: 'z/Test/set',
            wrap: 'state',
            payload: 'CLOSE',
        });
    });

    it('a fan with numeric modes: percent through the mode, off and auto by name', () => {
        const generated = generateOne(
            device('E2006', [
                {
                    type: 'fan',
                    features: [
                        {
                            type: 'binary',
                            name: 'state',
                            property: 'fan_state',
                            access: 7,
                            value_on: 'ON',
                            value_off: 'OFF',
                        },
                        {
                            type: 'enum',
                            name: 'mode',
                            property: 'fan_mode',
                            access: 7,
                            values: ['off', 'auto', '1', '2', '3', '4', '5'],
                        },
                    ],
                },
                {type: 'numeric', name: 'pm25', property: 'pm25', access: 5, unit: 'µg/m³'},
            ]),
        );
        expect(types(generated.device)).toEqual({main: ['Fan', 'AirQualitySensor']});
        expect(mapping(generated.device, 'OnOff.onOff').status).toMatchObject({extract: 'fan_state'});
        expect(mapping(generated.device, 'FanControl.percentSetting')).toEqual({
            attribute: 'FanControl.percentSetting',
            status: {topic: 'z/Test', extract: 'fan_mode', map: {off: 0, '1': 20, '2': 40, '3': 60, '4': 80, '5': 100}},
            command: {
                topic: 'z/Test/set',
                wrap: 'fan_mode',
                template: "{{ 'off' if percent == 0 else ((percent * 5 / 100) | round(0, 'ceil') | int) }}",
            },
        });
        expect(mapping(generated.device, 'FanControl.fanMode')).toMatchObject({
            status: {map: {off: 'Off', auto: 'Auto'}},
            command: {format: {Off: 'off', Auto: 'auto', Low: '2', Medium: '4', High: '5'}},
        });
        expect(mapping(generated.device, 'Pm25ConcentrationMeasurement.measuredValue').status).toMatchObject({
            extract: 'pm25',
        });
    });

    it('a fan with named modes or a speed', () => {
        const named = generateOne(
            device('fan', [
                {
                    type: 'fan',
                    features: [
                        {
                            type: 'enum',
                            name: 'mode',
                            property: 'mode',
                            access: 7,
                            values: ['off', 'low', 'medium', 'high', 'on'],
                        },
                    ],
                },
            ]),
        ).device;
        expect(named.endpoints[0]!.mappings!.map(target)).toEqual(['FanControl.fanMode']);
        expect(mapping(named, 'FanControl.fanMode')).toMatchObject({
            status: {map: {off: 'Off', low: 'Low', medium: 'Medium', high: 'High', on: 'On'}},
            command: {format: {Off: 'off', Low: 'low', Medium: 'medium', High: 'high', On: 'on'}},
        });
        const speed = generateOne(
            device('fan', [
                {
                    type: 'fan',
                    features: [
                        {type: 'numeric', name: 'speed', property: 'speed', access: 7, value_min: 1, value_max: 4},
                    ],
                },
            ]),
        ).device;
        expect(mapping(speed, 'FanControl.percentSetting')).toMatchObject({
            status: {scale: {from: [1, 4], to: [0, 100]}, round: 0},
            command: {scale: {from: [1, 4], to: [0, 100]}, round: 0},
        });
    });

    it('an on/off remote: the bare actions become buttons, the moves do not', () => {
        const generated = generateOne(
            device('E1743', [
                {
                    type: 'enum',
                    name: 'action',
                    property: 'action',
                    access: 1,
                    values: ['on', 'off', 'brightness_move_up', 'brightness_move_down', 'brightness_stop'],
                },
                {type: 'numeric', name: 'battery', property: 'battery', access: 5, unit: '%'},
            ]),
        );
        expect(types(generated.device)).toEqual({
            main: ['GenericSwitch', 'PowerSource'],
            button_off: ['GenericSwitch'],
        });
        expect(mapping(generated.device, 'Switch').status).toMatchObject({map: {on: 'single'}});
        expect(generated.device.endpoints[0]!.options).toEqual({switch: {multiPressMax: 2}});
        expect(mapping(generated.device, 'Switch', 'button_off').status).toMatchObject({map: {off: 'single'}});
        expect(generated.device.endpoints[1]!.attributes).toEqual({
            Descriptor: {tagList: [{mfgCode: null, namespaceId: 7, tag: 1, label: 'button_off'}]},
        });
        expect(generated.unmapped).toEqual([
            'action:brightness_move_up',
            'action:brightness_move_down',
            'action:brightness_stop',
        ]);
    });

    it('a remote with prefixed buttons', () => {
        const generated = generateOne(
            device('E1524', [
                {
                    type: 'enum',
                    name: 'action',
                    property: 'action',
                    access: 1,
                    values: [
                        'toggle',
                        'brightness_up_click',
                        'brightness_up_hold',
                        'brightness_up_release',
                        'arrow_left_click',
                        'arrow_left_hold',
                        'arrow_left_release',
                    ],
                },
            ]),
        );
        expect(types(generated.device)).toEqual({
            main: ['GenericSwitch'],
            button_brightness_up: ['GenericSwitch'],
            button_arrow_left: ['GenericSwitch'],
        });
        expect(mapping(generated.device, 'Switch', 'button_brightness_up').status).toMatchObject({
            map: {brightness_up_click: 'single', brightness_up_hold: 'long', brightness_up_release: 'longRelease'},
        });
    });

    it('a remote whose unnamed button comes after a named one: the unnamed one is the device', () => {
        const generated = generateOne(
            device('ERS-10TZBVK-AA', [
                {
                    type: 'enum',
                    name: 'action',
                    property: 'action',
                    access: 1,
                    values: ['toggle', 'hue_move', 'single', 'double', 'hold', 'rotate_left'],
                },
            ]),
        );
        expect(types(generated.device)).toEqual({main: ['GenericSwitch'], button_toggle: ['GenericSwitch']});
        expect(mapping(generated.device, 'Switch').status).toMatchObject({
            map: {single: 'single', double: 'double', hold: 'long'},
        });
        expect(generated.unmapped).toEqual(['action:hue_move', 'action:rotate_left']);
    });

    it('a door lock with a lock state; a child lock is no door lock', () => {
        const lock = generateOne(
            device('lock', [
                {
                    type: 'lock',
                    features: [
                        {
                            type: 'binary',
                            name: 'state',
                            property: 'state',
                            access: 7,
                            value_on: 'LOCK',
                            value_off: 'UNLOCK',
                        },
                        {
                            type: 'enum',
                            name: 'lock_state',
                            property: 'lock_state',
                            access: 1,
                            values: ['not_fully_locked', 'locked', 'unlocked'],
                        },
                    ],
                },
            ]),
        ).device;
        expect(types(lock)).toEqual({main: ['DoorLock']});
        expect(mapping(lock, 'DoorLock.lockState')).toEqual({
            attribute: 'DoorLock.lockState',
            status: {
                topic: 'z/Test',
                extract: 'lock_state',
                map: {locked: 'Locked', unlocked: 'Unlocked', not_fully_locked: 'NotFullyLocked'},
            },
            command: {topic: 'z/Test/set', wrap: 'state', format: {Locked: 'LOCK', Unlocked: 'UNLOCK'}},
        });
        const childLock = z2m.generateDevice(
            z2m.rawDevice(
                device('switch', [
                    {
                        type: 'lock',
                        features: [
                            {
                                type: 'binary',
                                name: 'state',
                                property: 'child_lock',
                                access: 7,
                                value_on: 'LOCK',
                                value_off: 'UNLOCK',
                            },
                        ],
                    },
                ]),
                'z',
            ),
        );
        expect(childLock).toBeUndefined();
    });

    it('hue/saturation only, Fahrenheit, a water leak, rain, smoke, a plain switch', () => {
        const generated = generateOne(
            device('mix', [
                {
                    type: 'light',
                    endpoint: 'rgb',
                    features: [
                        {
                            type: 'binary',
                            name: 'state',
                            property: 'state_rgb',
                            access: 7,
                            value_on: 'ON',
                            value_off: 'OFF',
                        },
                        {
                            type: 'numeric',
                            name: 'brightness',
                            property: 'brightness_rgb',
                            access: 7,
                            value_min: 0,
                            value_max: 254,
                        },
                        {type: 'composite', name: 'color_hs', property: 'color_rgb', access: 7},
                    ],
                },
                {
                    type: 'switch',
                    endpoint: 'relay',
                    features: [
                        {
                            type: 'binary',
                            name: 'state',
                            property: 'state_relay',
                            access: 7,
                            value_on: 'ON',
                            value_off: 'OFF',
                        },
                    ],
                },
                {type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°F'},
                {
                    type: 'binary',
                    name: 'water_leak',
                    property: 'water_leak',
                    access: 1,
                    value_on: true,
                    value_off: false,
                },
                {type: 'binary', name: 'rain', property: 'rain', access: 1, value_on: true, value_off: false},
                {type: 'binary', name: 'smoke', property: 'smoke', access: 1, value_on: true, value_off: false},
                {
                    type: 'binary',
                    name: 'battery_low',
                    property: 'battery_low',
                    access: 1,
                    value_on: true,
                    value_off: false,
                },
            ]),
        );
        const d = generated.device;
        expect(types(d)).toEqual({
            main: ['WaterLeakDetector', 'RainSensor', 'SmokeCoAlarm', 'TemperatureSensor', 'PowerSource'],
            rgb: ['ExtendedColorLight'],
            relay: ['OnOffPlugInUnit'],
        });
        expect(mapping(d, 'ColorControl.colorHs', 'rgb')).toMatchObject({
            status: {extract: 'color_rgb'},
            command: {wrap: 'color_rgb'},
        });
        expect(d.endpoints.find((e) => e.id === 'rgb')!.features).toBeUndefined();
        expect(mapping(d, 'TemperatureMeasurement.measuredValue').status).toMatchObject({unit: 'fahrenheit'});
        expect(mapping(d, 'SmokeCoAlarm.smokeState').status).toMatchObject({map: {true: 'Critical', false: 'Normal'}});
        expect(d.endpoints[0]!.features).toEqual({SmokeCoAlarm: ['SmokeAlarm']});
        expect(mapping(d, 'PowerSource.batChargeLevel').status).toMatchObject({map: {true: 'Critical', false: 'Ok'}});
    });

    it('nothing to map, not supported, not interviewed', () => {
        expect(z2m.unsupportedReason(device('x', [], {supported: false}))).toBe('not supported by zigbee2mqtt');
        expect(z2m.unsupportedReason(device('x', [], {interview_completed: false}))).toBe('interview not completed');
        expect(z2m.unsupportedReason(device('x', [], {disabled: true}))).toBe('disabled in zigbee2mqtt');
        expect(z2m.unsupportedReason(device('x', []))).toBe('no exposes');
        expect(
            z2m.generateDevice(
                z2m.rawDevice(
                    device('x', [{type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1}]),
                    'z',
                ),
            ),
        ).toBeUndefined();
        // a battery alone is no device
        expect(
            z2m.generateDevice(
                z2m.rawDevice(device('x', [{type: 'numeric', name: 'battery', property: 'battery', access: 1}]), 'z'),
            ),
        ).toBeUndefined();
    });

    it('labels are cut to 32 characters, endpoint ids made safe', () => {
        const d = generateOne(
            device(
                'a-model-name-that-is-far-too-long-for-matter',
                [
                    {
                        type: 'switch',
                        endpoint: 'left side',
                        features: [{type: 'binary', name: 'state', property: 'state_left side', access: 7}],
                    },
                ],
                {
                    friendly_name: 'a friendly name that is far too long for a matter label',
                },
            ),
        ).device;
        expect(d.name).toHaveLength(32);
        expect(d.model).toHaveLength(32);
        expect(d.endpoints[0]!.id).toBeUndefined();
        expect(z2m.endpointId('left side')).toBe('left_side');
        expect(z2m.endpointId('_x')).toBe('e_x');
    });
});

describe('scenes', () => {
    it("a device's scenes become momentary outlets that recall them; the device keeps its own endpoint", () => {
        const d = baseline('z2m:0x54ef44100086d51f');
        expect(d.source?.raw).toMatchObject({
            scenes: [
                {id: 0, name: 'OFF'},
                {id: 1, name: 'ON'},
            ],
        });
        expect(d.endpoints[0]!.deviceTypes[0]).toBe('OnOffPlugInUnit');
        expect(d.endpoints[0]!.options?.onOff).toBeUndefined();
        const scenes = d.endpoints.filter((e) => e.id?.startsWith('scene_') === true);
        expect(scenes.map((e) => e.id)).toEqual(['scene_0', 'scene_1']);
        expect(scenes[1]).toMatchObject({
            deviceTypes: ['OnOffPlugInUnit'],
            options: {onOff: {momentary: 1000}},
            mappings: [
                {
                    attribute: 'OnOff.onOff',
                    command: {topic: 'zigbee2mqtt/Aqara switch T1/set', format: {true: '{"scene_recall":1}'}},
                },
            ],
            attributes: {Descriptor: {tagList: [{namespaceId: 7, label: 'ON'}]}},
        });
    });

    it("a group's scenes: a group of thermostats still recalls its scene", () => {
        const g = baseline('z2m:group:10');
        expect(types(g)).toEqual({main: ['OnOffPlugInUnit']});
        expect(g.endpoints[0]).toMatchObject({
            options: {onOff: {momentary: 1000}},
            mappings: [
                {
                    attribute: 'OnOff.onOff',
                    command: {topic: 'zigbee2mqtt/Thermostats/set', format: {true: '{"scene_recall":0}'}},
                },
            ],
        });
        // a light group with scenes: the lights stay the device, the scenes are children
        const lights = groups.find((group) => group.id === 7)!;
        const withScenes = z2m.discover({devices, groups: [{...lights, scenes: [{id: 3, name: 'Evening'}]}]});
        const lightGroup = withScenes.items.find((i) => i.key === 'z2m:group:7')!.baseline!;
        expect(lightGroup.endpoints.map((e) => e.id ?? 'main')).toEqual(['main', 'scene_3']);
    });

    it('a device without scenes keeps its raw description as it was (no re-sync for everyone)', () => {
        expect(baseline('z2m:0xa4c138071003495f').source?.raw).not.toHaveProperty('scenes');
    });
});

describe('parseActions', () => {
    it('sorts action values into buttons and kinds', () => {
        const parsed = z2m.parseActions([
            'single',
            'double_click',
            'long_press',
            'hold_release',
            'single_l1',
            'hold_l1',
            'toggle',
            'rotate_left',
            'scene_1',
            'brightness_stop',
            'shake',
            'flip90',
        ]);
        expect(parsed.buttons.map((b) => [b.name, [...b.kinds.entries()]])).toEqual([
            [
                '',
                [
                    ['single', 'single'],
                    ['double_click', 'double'],
                    ['long_press', 'long'],
                    ['hold_release', 'longRelease'],
                ],
            ],
            [
                'l1',
                [
                    ['single_l1', 'single'],
                    ['hold_l1', 'long'],
                ],
            ],
            ['toggle', [['toggle', 'single']]],
            ['shake', [['shake', 'single']]],
            ['flip90', [['flip90', 'single']]],
        ]);
        expect(parsed.ignored).toEqual(['rotate_left', 'scene_1', 'brightness_stop']);
        expect(z2m.multiPressMax(parsed.buttons[0]!)).toBe(2);
    });
});
