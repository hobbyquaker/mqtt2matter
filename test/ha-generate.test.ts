/* The Home Assistant discovery generator over the corpus of test/fixtures/ha (see its README): expected
   device types, endpoints, mappings and the unmapped list per device; every baseline parses, validates
   and passes the strict dry run. */

import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {ha} from '../src/importers/index.ts';
import {checkConfig, formatCheck} from '../src/matter/check.ts';
import {type MappingInput, type DeviceInput, DeviceSchema, validateDevice} from '../src/model/index.ts';

import {CORPUS, loadCorpus} from './helpers/ha-corpus.ts';

const source = new ha.HaSource();
loadCorpus(source, ...CORPUS);
const discovery = source.discover();
const byKey = new Map(discovery.items.map((item) => [item.key, item]));

function item(key: string): ha.Discovered {
    const found = byKey.get(key);
    if (found === undefined) {
        throw new Error(`${key}: not discovered`);
    }
    return found;
}

function baseline(key: string): DeviceInput {
    const found = item(key);
    if (found.baseline === undefined) {
        throw new Error(`${key}: ${found.reason ?? 'no baseline'}`);
    }
    return found.baseline;
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
    it('discovers every device of the corpus, grouped by identifier', () => {
        expect(discovery.seen).toBe(true);
        expect(discovery.items.length).toBe(43);
        const unsupported = discovery.items.filter((i) => !i.supported).map((i) => i.key);
        expect(unsupported.sort()).toEqual(
            [
                'ha:cam00001',
                'ha:cam00002',
                'ha:cul2mqtt_cul',
                'ha:cul2mqtt_cul_Bell',
                'ha:ecoflow2mqtt_ecoflow',
                'ha:fritz2mqtt_fritz',
                'ha:unifi2mqtt_unifi_client_aa0000000009',
            ].sort(),
        );
    });

    it('every baseline parses and validates statically', () => {
        for (const entry of discovery.items) {
            if (entry.baseline === undefined) {
                continue;
            }
            const parsed = DeviceSchema.safeParse(entry.baseline);
            expect(parsed.success, `${entry.key} ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
            if (parsed.success) {
                const result = validateDevice(parsed.data);
                expect(result.errors, `${entry.key} ${JSON.stringify(result.errors)}`).toEqual([]);
            }
        }
    });

    it('every baseline passes the strict matter.js dry run', async () => {
        const {devices: adopted} = ha.adopt({}, discovery);
        expect(Object.keys(adopted)).toHaveLength(36);
        const result = await checkConfig(parseConfig({log: {matter: 'error'}, devices: adopted}));
        expect(formatCheck(result).filter((l) => l.startsWith('ERROR'))).toEqual([]);
        expect(result.ok).toBe(true);
    }, 90_000);
});

describe('ESPHome (per-entity form, abbreviated, identifiers as a string)', () => {
    it('a relay with a suggested area: an outlet with the Kitchen area tag', () => {
        const key = 'ha:aa0000000002';
        expect(item(key)).toMatchObject({name: 'Fairy lights', vendor: 'Espressif', model: 'esp01_1m', area: 'Küche'});
        const device = baseline(key);
        expect(device).toMatchObject({
            name: 'Fairy lights',
            serial: 'aa0000000002',
            source: {kind: 'ha-discovery', key: 'aa0000000002'},
            availability: {topic: 'usb-relay-02/status'},
        });
        expect(types(device)).toEqual({main: ['OnOffPlugInUnit']});
        expect(device.endpoints[0]!).toMatchObject({
            features: {Descriptor: ['TagList']},
            attributes: {Descriptor: {tagList: [{mfgCode: null, namespaceId: 16, tag: 47, label: 'Küche'}]}},
        });
        expect(mapping(device, 'OnOff.onOff')).toEqual({
            attribute: 'OnOff.onOff',
            status: {topic: 'usb-relay-02/status/relay', map: {ON: true, OFF: false}},
            command: {topic: 'usb-relay-02/set/relay', format: {true: 'ON', false: 'OFF'}},
        });
        expect(item(key).unmapped).toEqual([
            'binary_sensor "button": no device_class; a binary sensor without one has no Matter sensor type',
        ]);
    });

    it('a thermostat with switches and sensors: the climate is the device, the rest children', () => {
        const device = baseline('ha:aa0000000003');
        expect(types(device)).toEqual({
            main: ['Thermostat'],
            heating: ['OnOffPlugInUnit'],
            light: ['OnOffPlugInUnit'],
            humidity: ['HumiditySensor'],
            temperature: ['TemperatureSensor'],
        });
        expect(device.endpoints[0]!.options).toEqual({climate: {minHeat: 10, maxHeat: 30}});
        expect(device.endpoints[0]!.coalesce).toBe(50);
        expect(mapping(device, 'Thermostat.localTemperature').status).toEqual({
            topic: 'seedling/climate/thermostat/current_temperature/state',
            unit: 'celsius',
            type: 'number',
        });
        expect(mapping(device, 'Thermostat.occupiedHeatingSetpoint')).toEqual({
            attribute: 'Thermostat.occupiedHeatingSetpoint',
            status: {topic: 'seedling/climate/thermostat/target_temperature/state', unit: 'celsius', type: 'number'},
            command: {topic: 'seedling/climate/thermostat/target_temperature/command', unit: 'celsius', round: 1},
        });
        expect(mapping(device, 'Thermostat.systemMode')).toEqual({
            attribute: 'Thermostat.systemMode',
            status: {topic: 'seedling/climate/thermostat/mode/state', map: {off: 'Off', heat: 'Heat'}},
            command: {topic: 'seedling/climate/thermostat/mode/command', format: {Off: 'off', Heat: 'heat'}},
        });
        expect(mapping(device, 'Thermostat.thermostatRunningState').status?.map).toMatchObject({
            heating: 'heat',
            idle: '',
        });
        expect(device.endpoints.find((e) => e.id === 'light')).toMatchObject({
            features: {Descriptor: ['TagList']},
            attributes: {Descriptor: {tagList: [{mfgCode: null, namespaceId: 7, tag: 2, label: 'light'}]}},
        });
        expect(item('ha:aa0000000003').unmapped).toEqual(['climate "thermostat": preset modes are not mapped']);
    });

    it('a presence radar: occupancy sensors as tagged siblings, settings and metrics listed', () => {
        const device = baseline('ha:aa0000000001');
        expect(types(device)).toEqual({
            main: ['OccupancySensor'],
            presence: ['OccupancySensor'],
            still_target: ['OccupancySensor'],
        });
        expect(mapping(device, 'OccupancySensing.occupancy', 'presence').status).toEqual({
            topic: 'radar-one/status/has_target',
            map: {ON: true, OFF: false},
        });
        const unmapped = item('ha:aa0000000001').unmapped;
        expect(unmapped).toContain(
            `switch "engineering mode": config entity (a setting or a metric, not the device's function)`,
        );
        expect(unmapped).toContain('sensor "Moving Distance": device_class distance in cm has no Matter sensor type');
        expect(unmapped).toContain(
            'sensor "brightness": device_class voltage: electrical measurement is not mapped yet',
        );
    });

    it('an air quality sensor: the concentration clusters with their unit conversions', () => {
        const device = baseline('ha:aa0000000006');
        expect(types(device)).toEqual({
            main: ['AirQualitySensor'],
            bme680_co2_equivalent: ['AirQualitySensor'],
            bme680_humidity: ['HumiditySensor'],
            bme680_pressure: ['PressureSensor'],
            bme680_temperature: ['TemperatureSensor'],
            pm2_5: ['AirQualitySensor'],
        });
        // VOC in ppm → ppb
        expect(mapping(device, 'TotalVolatileOrganicCompoundsConcentrationMeasurement.measuredValue').status).toEqual({
            topic: 'vindriktning/status/voc',
            type: 'number',
            scale: {from: [0, 1], to: [0, 1000], clamp: false},
        });
        expect(mapping(device, 'Pm25ConcentrationMeasurement.measuredValue', 'pm2_5').status).toEqual({
            topic: 'vindriktning/status/pm25',
            type: 'number',
        });
        expect(mapping(device, 'PressureMeasurement.measuredValue', 'bme680_pressure').status).toEqual({
            topic: 'vindriktning/status/pressure',
            type: 'number',
            round: 0,
        });
    });
});

describe('the meter digitizer (~, payload_available, identifiers with a slash)', () => {
    it('the gas meter: only its flow rate maps, the rest is listed; the water meter is not a valid discovery', () => {
        // v15 publishes `<prefix>/sensor/<name>/status/<object>/config`: five levels, which Home Assistant ignores too
        expect(byKey.has('ha:watermeter_status')).toBe(false);
        const gas = item('ha:gasmeter_status');
        expect(gas.supported).toBe(true);
        expect(gas.name).toBe('gasmeter/status');
        expect(types(gas.baseline!)).toEqual({main: ['FlowSensor']});
        expect(mapping(gas.baseline!, 'FlowMeasurement.measuredValue').status).toEqual({
            topic: 'gasmeter/status/main/rate_per_time_unit',
            type: 'number',
            scale: {from: [0, 1], to: [0, 10], clamp: false},
            round: 0,
        });
        expect(gas.baseline!.availability).toEqual({
            topic: 'gasmeter/status/connection',
            online: 'connected',
            offline: 'connection lost',
        });
        expect(gas.unmapped).toContain(
            'button "Manual Flow Start": a Matter button emits events, it cannot be pressed; no equivalent',
        );
        expect(gas.unmapped).toContain('binary_sensor "Problem": device_class problem has no Matter sensor type');
        expect(gas.unmapped).toContain('sensor "Value": device_class gas in m³ has no Matter sensor type');
        expect(gas.unmapped.some((u) => u.startsWith('sensor "Uptime": diagnostic entity'))).toBe(true);
    });
});

describe("zigbee2mqtt's own discovery (native preferred)", () => {
    it("marks every device with the zigbee2mqtt importer's key", () => {
        expect(item('ha:zigbee2mqtt_0x00124b0000000001').native).toBe('z2m:0x00124b0000000001');
        expect(item('ha:zigbee2mqtt_1000000000000000000000000000001_2').native).toBe('z2m:group:2');
        expect(item('ha:aa0000000002').native).toBeUndefined();
    });

    it('a json-schema light: one JSON state and command topic, coalesced', () => {
        const device = baseline('ha:zigbee2mqtt_0x00124b0000000001');
        expect(device).toMatchObject({
            name: 'light_cellar_1',
            vendor: 'Philips',
            availability: {
                mode: 'all',
                topics: [
                    {topic: 'zigbee2mqtt/bridge/state', template: '{{ value_json.state }}'},
                    {topic: 'zigbee2mqtt/light_cellar_1/availability', template: '{{ value_json.state }}'},
                ],
            },
        });
        expect(types(device)).toEqual({main: ['ExtendedColorLight']});
        expect(device.endpoints[0]!).toMatchObject({coalesce: 50, options: {light: {minMireds: 153, maxMireds: 500}}});
        expect(mapping(device, 'OnOff.onOff')).toEqual({
            attribute: 'OnOff.onOff',
            status: {topic: 'zigbee2mqtt/light_cellar_1', extract: 'state', map: {ON: true, OFF: false}},
            command: {topic: 'zigbee2mqtt/light_cellar_1/set', wrap: 'state', format: {true: 'ON', false: 'OFF'}},
        });
        expect(mapping(device, 'LevelControl.currentLevel').command).toEqual({
            topic: 'zigbee2mqtt/light_cellar_1/set',
            wrap: 'brightness',
            scale: {from: [1, 254], to: [1, 254]},
            round: 0,
        });
        expect(mapping(device, 'ColorControl.colorXy')).toEqual({
            attribute: 'ColorControl.colorXy',
            status: {topic: 'zigbee2mqtt/light_cellar_1', extract: 'color'},
            command: {topic: 'zigbee2mqtt/light_cellar_1/set', wrap: 'color'},
        });
        expect(mapping(device, 'ColorControl.colorMode').status?.map).toMatchObject({
            xy: 'CurrentXAndCurrentY',
            color_temp: 'ColorTemperatureMireds',
        });
        expect(item('ha:zigbee2mqtt_0x00124b0000000001').unmapped).toContain(
            'light "light": effects have no Matter equivalent',
        );
    });

    it("a position-aware cover with a set_position_template: HA's position variable is given its meaning", () => {
        const device = baseline('ha:zigbee2mqtt_0x00124b0000000002');
        // the battery sensor is diagnostic in zigbee2mqtt's discovery and still the power source here
        expect(types(device)).toEqual({main: ['WindowCovering', 'PowerSource']});
        expect(mapping(device, 'PowerSource.batPercentRemaining').status).toMatchObject({unit: 'halfPercent'});
        expect(mapping(device, 'WindowCovering.currentPositionLiftPercent100ths').status).toEqual({
            topic: 'zigbee2mqtt/blind_kitchen',
            scale: {from: [0, 100], to: [10000, 0]},
            type: 'number',
            template: '{{ value_json.position }}',
        });
        expect(mapping(device, 'WindowCovering.targetPositionLiftPercent100ths').command).toEqual({
            topic: 'zigbee2mqtt/blind_kitchen/set',
            scale: {from: [0, 100], to: [10000, 0]},
            round: 0,
            template: '{% set position = open %}{ "position": {{ position }} }',
        });
        // a position-aware cover takes only the movement states from the state topic
        expect(mapping(device, 'WindowCovering.motion').status).toEqual({
            topic: 'zigbee2mqtt/blind_kitchen',
            map: {opening: 'opening', closing: 'closing', STOP: 'stopped'},
            template: '{{ value_json.state }}',
        });
        expect(mapping(device, 'WindowCovering.stopMotion').command).toEqual({
            topic: 'zigbee2mqtt/blind_kitchen/set',
            payload: 'STOP',
        });
        expect(device.endpoints[0]!.mappings?.map(target)).not.toContain('WindowCovering.upOrOpen');
    });

    it('a fan: the percentage over the speed range, a command template with integer dictionary keys left out', () => {
        const device = baseline('ha:zigbee2mqtt_0x00124b0000000003');
        expect(types(device)).toEqual({main: ['Fan'], pm25: ['AirQualitySensor']});
        const percent = mapping(device, 'FanControl.percentSetting');
        expect(percent.status).toMatchObject({scale: {from: [0, 9], to: [0, 100]}, type: 'number'});
        expect(percent.command).toBeUndefined();
        expect(mapping(device, 'FanControl.fanMode')).toMatchObject({
            status: {map: {auto: 'Auto'}},
            command: {format: {Auto: 'auto'}},
        });
        const unmapped = item('ha:zigbee2mqtt_0x00124b0000000003').unmapped;
        expect(unmapped.some((u) => u.includes('percentage_command_template a dictionary with non-string keys'))).toBe(
            true,
        );
    });

    it('device triggers: one button per subtype, continuous actions listed', () => {
        const device = baseline('ha:zigbee2mqtt_0x00124b0000000004');
        expect(types(device)).toEqual({main: ['GenericSwitch', 'PowerSource'], button_toggle: ['GenericSwitch']});
        expect(mapping(device, 'Switch')).toEqual({
            event: 'Switch',
            status: {topic: 'zigbee2mqtt/knob_workshop/action', map: {single: 'single'}},
        });
        expect(mapping(device, 'Switch', 'button_toggle').status?.map).toEqual({toggle: 'single'});
        expect(item('ha:zigbee2mqtt_0x00124b0000000004').unmapped).toContain(
            'device_automation: action rotate_left is no press',
        );
    });

    it('a group with a scene: the scene is listed for later', () => {
        const key = 'ha:zigbee2mqtt_1000000000000000000000000000001_2';
        expect(types(baseline(key))).toEqual({main: ['ExtendedColorLight']});
        expect(item(key).unmapped).toContain('scene "color1": scenes are not mapped yet');
    });
});

describe('the device-based form', () => {
    it('a sensor device with two availability topics in mode all', () => {
        const device = baseline('ha:cul2mqtt_cul_ws_2');
        expect(device).toMatchObject({
            name: 'ws/2',
            vendor: 'ELV',
            model: 'S300TH',
            availability: {
                mode: 'all',
                topics: [
                    {topic: 'cul/connected', template: "{{ 'online' if (value | int(0)) >= 2 else 'offline' }}"},
                    {topic: 'cul/status/ws/2/online', template: "{{ 'online' if value_json.val else 'offline' }}"},
                ],
            },
        });
        expect(types(device)).toEqual({main: ['HumiditySensor'], temperature: ['TemperatureSensor']});
        expect(mapping(device, 'RelativeHumidityMeasurement.measuredValue').status).toEqual({
            topic: 'cul/status/ws/2/humidity',
            type: 'number',
            unit: 'percent100ths',
            template: '{{ value_json.val }}',
        });
    });

    it('a battery-low binary sensor becomes the power source of the device', () => {
        const device = baseline('ha:cul2mqtt_cul_hms_4334');
        expect(types(device)).toEqual({main: ['TemperatureSensor', 'PowerSource']});
        expect(mapping(device, 'PowerSource.batChargeLevel').status).toEqual({
            topic: 'cul/status/hms/4334/battery_low',
            map: {ON: 'Critical', OFF: 'Ok'},
            template: "{{ 'ON' if value_json.val else 'OFF' }}",
        });
    });

    it('a default-schema light with rgb templates (one device, several lights)', () => {
        const device = baseline('ha:aa0000000008');
        expect(device).toMatchObject({name: 'awtrix-ng', vendor: 'Blueforcer', model: 'AWTRIX NG'});
        // the first light is the device, its battery sensor the power source; the matrix is a child
        expect(device.endpoints.map((e) => `${e.id ?? 'main'}:${e.deviceTypes.join('+')}`)).toEqual([
            'main:ExtendedColorLight+PowerSource',
            'ind2:ExtendedColorLight',
            'ind3:ExtendedColorLight',
            'mat:ExtendedColorLight',
            'trans:OnOffPlugInUnit',
        ]);
        expect(mapping(device, 'LevelControl.currentLevel', 'mat')).toMatchObject({
            status: {topic: 'awtrix/state/device', template: '{{ value_json.brightness }}', type: 'number'},
            command: {topic: 'awtrix/cmd/settings', template: '{"brightness":{{ value }}}'},
        });
        expect(mapping(device, 'ColorControl.colorRgb', 'mat').command).toMatchObject({
            topic: 'awtrix/cmd/settings',
            template: '{"textColor":[{{ red }},{{ green }},{{ blue }}]}',
        });
        // the rgb state template uses int(base=16), which the engine cannot do: status half left out, listed
        expect(mapping(device, 'ColorControl.colorRgb', 'mat').status).toBeUndefined();
        expect(item('ha:aa0000000008').unmapped.some((u) => u.includes('rgb_value_template "int(base=\u2026)"'))).toBe(
            true,
        );
        expect(mapping(device, 'OnOff.onOff', 'mat')).toMatchObject({
            status: {map: {'{"power":true}': true, '{"power":false}': false}},
            command: {format: {true: '{"power":true}', false: '{"power":false}'}},
        });
        expect(device.endpoints.some((e) => e.options?.light?.onCommandType === 'first')).toBe(true);
    });

    it('a device tracker is listed, not mapped', () => {
        const tracker = item('ha:unifi2mqtt_unifi_client_aa0000000009');
        expect(tracker.supported).toBe(false);
        expect(tracker.unmapped).toEqual([
            'device_tracker "Presence": the device_tracker component has no Matter equivalent',
        ]);
    });
});

describe('Tasmota (hand-written from its documentation)', () => {
    it('a light with brightness, colour temperature, rgb and the on_command_type', () => {
        const key = 'ha:AABBCC';
        expect(item(key)).toMatchObject({name: 'Tasmota Light', area: 'Living room'});
        const device = baseline(key);
        expect(types(device)).toEqual({main: ['ExtendedColorLight']});
        expect(device.endpoints[0]!.options).toEqual({light: {onCommandType: 'brightness'}});
        expect(device.endpoints[0]!.attributes).toEqual({
            Descriptor: {tagList: [{mfgCode: null, namespaceId: 16, tag: 52, label: 'Living room'}]},
        });
        expect(mapping(device, 'LevelControl.currentLevel')).toEqual({
            attribute: 'LevelControl.currentLevel',
            status: {
                topic: 'tele/tasmota_AABBCC/STATE',
                scale: {from: [1, 100], to: [1, 254]},
                type: 'number',
                template: '{{value_json.Dimmer}}',
            },
            command: {topic: 'cmnd/tasmota_AABBCC/Dimmer', scale: {from: [1, 100], to: [1, 254]}, round: 0},
        });
        expect(mapping(device, 'ColorControl.colorRgb')).toEqual({
            attribute: 'ColorControl.colorRgb',
            status: {topic: 'tele/tasmota_AABBCC/STATE', template: "{{value_json.Color.split(',')[0:3]|join(',')}}"},
            command: {topic: 'cmnd/tasmota_AABBCC/Color2', template: '{{ red }},{{ green }},{{ blue }}'},
        });
        expect(device.availability).toEqual({topic: 'tele/tasmota_AABBCC/LWT', online: 'Online', offline: 'Offline'});
    });

    it('a relay with a temperature sensor: the device info merged from every entity', () => {
        const device = baseline('ha:DDEEFF');
        expect(device).toMatchObject({name: 'Tasmota Relay', vendor: 'Tasmota', model: 'Sonoff Basic'});
        expect(types(device)).toEqual({main: ['OnOffPlugInUnit'], DDEEFF_DS18B20_Temperature: ['TemperatureSensor']});
        expect(mapping(device, 'TemperatureMeasurement.measuredValue', 'DDEEFF_DS18B20_Temperature').status).toEqual({
            topic: 'tele/tasmota_DDEEFF/SENSOR',
            type: 'number',
            unit: 'celsius',
            template: "{{value_json['DS18B20'].Temperature}}",
        });
    });

    it('a two-gang with native device triggers: two outlets and two buttons, all tagged', () => {
        const device = baseline('ha:112233');
        expect(types(device)).toEqual({
            main: ['OnOffPlugInUnit'],
            '112233_RL_2': ['OnOffPlugInUnit'],
            button_button_1: ['GenericSwitch'],
            button_button_2: ['GenericSwitch'],
        });
        expect(mapping(device, 'Switch', 'button_button_1')).toEqual({
            event: 'Switch',
            status: {topic: 'stat/tasmota_112233/BUTTON1T', map: {SINGLE: 'single', DOUBLE: 'double', HOLD: 'long'}},
        });
        expect(device.endpoints.find((e) => e.id === 'button_button_1')?.options).toEqual({switch: {multiPressMax: 2}});
        expect(device.endpoints.slice(1).map((e) => e.attributes?.Descriptor)).toEqual([
            {tagList: [{mfgCode: null, namespaceId: 7, tag: 1, label: '112233_RL_2'}]},
            {tagList: [{mfgCode: null, namespaceId: 7, tag: 2, label: 'button_button_1'}]},
            {tagList: [{mfgCode: null, namespaceId: 7, tag: 3, label: 'button_button_2'}]},
        ]);
    });

    it('a shutter: position both ways, stop, no open/close commands', () => {
        const device = baseline('ha:445566');
        expect(device.endpoints[0]!.mappings?.map(target)).toEqual([
            'WindowCovering.currentPositionLiftPercent100ths',
            'WindowCovering.targetPositionLiftPercent100ths',
            'WindowCovering.motion',
            'WindowCovering.stopMotion',
        ]);
    });
});

describe('Shelly (hand-written)', () => {
    it('a Gen2 switch with a ~ prefix and a JSON status', () => {
        const device = baseline('ha:shellyplus1-a1b2c3');
        expect(device).toMatchObject({name: 'Shelly Plus 1', vendor: 'Shelly', model: 'SNSW-001X16EU'});
        expect(item('ha:shellyplus1-a1b2c3').area).toBe('Boiler room');
        expect(device.endpoints[0]!.attributes).toBeUndefined();
        expect(mapping(device, 'OnOff.onOff')).toEqual({
            attribute: 'OnOff.onOff',
            status: {
                topic: 'shellyplus1-a1b2c3/status/switch:0',
                map: {on: true, off: false},
                template: "{{ 'ON' if value_json.output else 'OFF' }}",
            },
            command: {topic: 'shellyplus1-a1b2c3/command/switch:0', format: {true: 'on', false: 'off'}},
        });
        expect(device.availability).toEqual({topic: 'shellyplus1-a1b2c3/online', online: 'true', offline: 'false'});
    });

    it('a Gen2 cover with a set_position_template', () => {
        const device = baseline('ha:shellyplus2pm-d4e5f6');
        expect(mapping(device, 'WindowCovering.targetPositionLiftPercent100ths').command?.template).toBe(
            '{% set position = open %}pos,{{ position }}',
        );
        expect(item('ha:shellyplus2pm-d4e5f6').unmapped).toEqual([
            'sensor "Power": device_class power: electrical measurement is not mapped yet',
        ]);
    });

    it('a battery sensor with expire_after: the power source on the device, expire on every topic', () => {
        const device = baseline('ha:shellyht-abc123');
        expect(types(device)).toEqual({main: ['HumiditySensor', 'PowerSource'], temperature: ['TemperatureSensor']});
        expect(mapping(device, 'PowerSource.batPercentRemaining').status).toEqual({
            topic: 'shellies/shellyht-abc123/sensor/battery',
            type: 'number',
            unit: 'halfPercent',
            expire: 43200,
        });
        expect(mapping(device, 'TemperatureMeasurement.measuredValue', 'temperature').status?.expire).toBe(43200);
        expect(device.endpoints[0]!.attributes?.Descriptor).toEqual({
            tagList: [{mfgCode: null, namespaceId: 16, tag: 7, label: 'Bedroom'}],
        });
    });

    it('an event entity: one button with the press kinds from the event types', () => {
        const device = baseline('ha:shellyplusi4-778899');
        expect(types(device)).toEqual({main: ['GenericSwitch']});
        expect(device.endpoints[0]!.options).toEqual({switch: {multiPressMax: 3}});
        expect(mapping(device, 'Switch').status).toEqual({
            topic: 'shellyplusi4-778899/events/rpc',
            map: {single_push: 'single', double_push: 'double', triple_push: 'triple', long_push: 'long'},
            template: '{{ value_json.params.events[0].event }}',
        });
    });
});

describe('Z-Wave JS UI (hand-written)', () => {
    it('a door sensor with numeric payloads: inverted into the contact state', () => {
        expect(mapping(baseline('ha:zwavejs2mqtt_0xd1e5f8a1_node9'), 'BooleanState.stateValue').status).toEqual({
            topic: 'zwave/9/113/0/Access_Control/Door_state_simple',
            map: {'22': false, '23': true},
            template: '{{ value_json.value }}',
        });
    });

    it('a dimmer: brightness scale 99, on by brightness', () => {
        const device = baseline('ha:zwavejs2mqtt_0xd1e5f8a1_node12');
        expect(types(device)).toEqual({main: ['DimmableLight']});
        expect(mapping(device, 'LevelControl.currentLevel').command).toEqual({
            topic: 'zwave/12/38/0/targetValue/set',
            scale: {from: [1, 99], to: [1, 254]},
            round: 0,
        });
        expect(mapping(device, 'OnOff.onOff').command?.format).toEqual({true: '255', false: '0'});
    });

    it('a lock with numeric states', () => {
        expect(mapping(baseline('ha:zwavejs2mqtt_0xd1e5f8a1_node10'), 'DoorLock.lockState')).toEqual({
            attribute: 'DoorLock.lockState',
            status: {
                topic: 'zwave/10/98/0/currentMode',
                map: {'255': 'Locked', '0': 'Unlocked', JAMMED: 'NotFullyLocked'},
                template: '{{ value_json.value }}',
            },
            command: {topic: 'zwave/10/98/0/targetMode/set', format: {Locked: '255', Unlocked: '0'}},
        });
    });

    it("a heat/cool thermostat on one setpoint topic; the mode templates get HA's value", () => {
        const device = baseline('ha:zwavejs2mqtt_0xd1e5f8a1_node11');
        expect(device.endpoints[0]!.options).toEqual({climate: {minHeat: 5, maxHeat: 40, minCool: 5, maxCool: 40}});
        expect(mapping(device, 'Thermostat.occupiedCoolingSetpoint').command).toEqual({
            topic: 'zwave/11/67/0/setpoint/1/set',
            unit: 'celsius',
            round: 1,
            template: '{{ value }}',
        });
        // the state template uses integer dictionary keys the engine cannot render: listed, no status half
        const mode = mapping(device, 'Thermostat.systemMode');
        expect(mode.status).toBeUndefined();
        expect(item('ha:zwavejs2mqtt_0xd1e5f8a1_node11').unmapped).toEqual([
            "climate \"nodeID_11_climate\": mode_state_template a dictionary with non-string keys is not available: {{ {0:'off', 1:'heat', 2:'cool', 3:'auto'}[value_json.value] | default('off') }}",
        ]);
        expect(mode.command?.template).toBe(
            '{% set value = "off" if name == "Off" else "heat" if name == "Heat" else "cool" if name == "Cool" else "auto" if name == "Auto" else name | lower %}' +
                "{{ {'off':0, 'heat':1, 'cool':2, 'auto':3}[value] }}",
        );
    });
});

describe('OpenMQTTGateway (hand-written)', () => {
    it('BLE sensors with is_defined and expire_after', () => {
        const device = baseline('ha:A4C138AABB01');
        expect(mapping(device, 'TemperatureMeasurement.measuredValue', 'A4C138AABB01-tempc').status).toEqual({
            topic: 'home/OMG_ESP32_BLE/BTtoMQTT/A4C138AABB01',
            type: 'number',
            unit: 'celsius',
            template: '{{ value_json.tempc | is_defined }}',
            expire: 21600,
        });
        expect(mapping(baseline('ha:A4C138AABB02'), 'BooleanState.stateValue').status?.map).toEqual({
            true: false,
            false: true,
        });
    });

    it('an RF switch with JSON payloads and separate state values', () => {
        const device = baseline('ha:OMG_ESP32_BLE');
        expect(mapping(device, 'OnOff.onOff')).toMatchObject({
            status: {map: {ON: true, OFF: false}},
            command: {format: {true: '{"value":1381717,"protocol":1,"length":24,"delay":350}'}},
        });
    });
});

describe('a template that cannot run leaves its half out', () => {
    it('switch with a states() value template: no status half, the command stays, the template listed', () => {
        const source = new ha.HaSource();
        source.handle(
            'homeassistant/switch/t/config',
            JSON.stringify({
                stat_t: 't/state',
                cmd_t: 't/set',
                val_tpl: "{{ states('sensor.other') }}",
                cmd_tpl: '{"state": "{{ value }}"}',
                uniq_id: 't',
                dev: {ids: ['t'], name: 'T'},
            }),
        );
        const [entry] = source.discover().items;
        expect(entry?.supported).toBe(true);
        const onOff = mapping(entry!.baseline!, 'OnOff.onOff');
        expect(onOff.status).toBeUndefined();
        expect(onOff.command).toEqual({
            topic: 't/set',
            template: '{% set value = "ON" if value else "OFF" %}{"state": "{{ value }}"}',
        });
        expect(entry?.unmapped).toEqual([
            `switch "t": value_template "states()" is not available: {{ states('sensor.other') }}`,
        ]);
    });

    it('an entity without a device block is listed as unsupported', () => {
        const source = new ha.HaSource();
        source.handle('homeassistant/sensor/lonely/config', JSON.stringify({stat_t: 'l', name: 'Lonely'}));
        const [entry] = source.discover().items;
        expect(entry).toMatchObject({supported: false, name: 'sensor Lonely'});
        expect(entry?.key).toMatch(/^ha:entity:[0-9a-f]{12}$/);
    });
});
