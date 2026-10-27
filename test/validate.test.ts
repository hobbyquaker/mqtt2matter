import {describe, expect, it} from 'vitest';

import {cluster, deviceType, deviceTypeNames} from '../src/model/catalog.ts';
import {DeviceSchema} from '../src/model/schema.ts';
import {effectiveFeatures, validateDevice} from '../src/model/validate.ts';

const device = (endpoints: unknown[], extra: Record<string, unknown> = {}) =>
    DeviceSchema.parse({name: 'd', endpoints, ...extra});

describe('catalog', () => {
    it('knows device types with their clusters and required features', () => {
        const light = deviceType('OnOffLight')!;
        expect(light.id).toBe(0x100);
        expect(light.classification).toBe('simple');
        expect(light.clusters.find((c) => c.cluster === 'OnOff')).toEqual({
            cluster: 'OnOff',
            mandatory: true,
            features: ['Lighting'],
        });
        expect(light.clusters.find((c) => c.cluster === 'LevelControl')?.mandatory).toBe(false);
        expect(deviceType('PowerSource')?.classification).toBe('utility');
        expect(deviceType('Nonsense')).toBeUndefined();
        expect(deviceTypeNames()).toContain('WindowCovering');
    });

    it('knows clusters, features, attributes, enums, bitmaps and commands', () => {
        const thermostat = cluster('Thermostat')!;
        expect(thermostat.behaviorId).toBe('thermostat');
        expect(thermostat.feature('HEAT')?.title).toBe('Heating');
        expect(thermostat.feature('Heating')?.code).toBe('HEAT');
        const mode = thermostat.attributes.get('systemMode')!;
        expect(mode.metatype).toBe('enum');
        expect(mode.writable).toBe(true);
        expect(mode.enumMembers?.get('Heat')).toBe(4);
        const running = thermostat.attributes.get('thermostatRunningState')!;
        expect(running.metatype).toBe('bitmap');
        expect(running.bitFields?.slice(0, 3)).toEqual([
            {name: 'heat', bit: 0},
            {name: 'cool', bit: 1},
            {name: 'fan', bit: 2},
        ]);
        const local = thermostat.attributes.get('localTemperature')!;
        expect(local.nullable).toBe(true);
        expect(local.writable).toBe(false);
        const setpoint = thermostat.attributes.get('occupiedHeatingSetpoint')!;
        expect(setpoint.applicability(['Heating'])).toBe(3);
        expect(setpoint.applicability(['Cooling'])).toBe(0);
        expect(cluster('WindowCovering')!.commands.get('goToLiftPercentage')?.fields).toEqual([
            'liftPercent100thsValue',
            'ignored',
        ]);
        expect(cluster('Switch')!.events).toContain('multiPressComplete');
        expect(cluster('Nope')).toBeUndefined();
    });
});

describe('validateDevice', () => {
    it('accepts a correct colour temperature light', () => {
        const result = validateDevice(
            device([
                {
                    deviceTypes: ['ColorTemperatureLight'],
                    mappings: [
                        {
                            attribute: 'OnOff.onOff',
                            status: {topic: 's', extract: 'POWER', map: {ON: true, OFF: false}},
                            command: {topic: 'c', format: {true: 'ON', false: 'OFF'}},
                        },
                        {
                            attribute: 'LevelControl.currentLevel',
                            status: {topic: 's', extract: 'Dimmer', scale: {from: [0, 100], to: [1, 254]}},
                        },
                        {
                            attribute: 'ColorControl.colorTemperatureMireds',
                            status: {topic: 's', extract: 'CT'},
                            command: {topic: 'c2'},
                        },
                    ],
                },
            ]),
        );
        expect(result.issues).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('finds unknown device types, clusters, attributes, commands and features', () => {
        const result = validateDevice(
            device([
                {
                    deviceTypes: ['Nonsense', 'OnOffLight'],
                    features: {OnOff: ['Sparkle'], Nope: ['X']},
                    attributes: {OnOff: {colour: 1}},
                    mappings: [
                        {attribute: 'OnOff.brightness', status: {topic: 's'}},
                        {attribute: 'Nope.x', status: {topic: 's'}},
                        {invoke: 'OnOff.explode', command: {topic: 'c', payload: 'x'}},
                        {event: 'DoorLock', status: {topic: 's'}},
                    ],
                },
            ]),
        );
        const messages = result.errors.map((e) => `${e.path}: ${e.message}`);
        expect(messages).toEqual([
            expect.stringContaining('deviceTypes[0]: device type "Nonsense"'),
            expect.stringContaining('features.OnOff: OnOff has no feature "Sparkle"'),
            expect.stringContaining('features.Nope: cluster "Nope"'),
            expect.stringContaining('attributes.OnOff.colour: OnOff has no attribute colour'),
            expect.stringContaining('mappings[0]: OnOff has no attribute brightness'),
            expect.stringContaining('mappings[1]: cluster "Nope"'),
            expect.stringContaining('mappings[2]: OnOff has no command explode'),
            expect.stringContaining('mappings[3]: event channel "DoorLock" is unknown'),
        ]);
    });

    it('checks conformance under the endpoint features', () => {
        const noHeating = validateDevice(
            device([
                {
                    deviceTypes: ['Thermostat'],
                    mappings: [
                        {attribute: 'Thermostat.occupiedCoolingSetpoint', status: {topic: 's'}},
                        {attribute: 'Thermostat.absMinHeatSetpointLimit', status: {topic: 's'}},
                    ],
                },
            ]),
        );
        expect(noHeating.errors.map((e) => e.message)).toEqual([
            expect.stringContaining('absMinHeatSetpointLimit needs a Thermostat feature'),
        ]);
        const withHeating = validateDevice(
            device([
                {
                    deviceTypes: ['Thermostat'],
                    mappings: [
                        {attribute: 'Thermostat.occupiedHeatingSetpoint', status: {topic: 's'}},
                        {attribute: 'Thermostat.absMinHeatSetpointLimit', status: {topic: 's'}},
                    ],
                },
            ]),
        );
        expect(withHeating.ok).toBe(true);
        const heatingEndpoint = device([
            {
                deviceTypes: ['Thermostat'],
                mappings: [{attribute: 'Thermostat.occupiedHeatingSetpoint', status: {topic: 's'}}],
            },
        ]).endpoints[0]!;
        expect(
            effectiveFeatures(heatingEndpoint, 'Thermostat', new Set(['Thermostat.occupiedHeatingSetpoint'])),
        ).toEqual(new Set(['Heating']));
        const hsOnCt = validateDevice(
            device([
                {
                    deviceTypes: ['ColorTemperatureLight'],
                    mappings: [{attribute: 'ColorControl.currentHue', status: {topic: 's'}}],
                },
            ]),
        );
        expect(hsOnCt.ok).toBe(true);
        const compositeWithoutFeature = validateDevice(
            device([
                {deviceTypes: ['DimmableLight'], mappings: [{attribute: 'ColorControl.colorXy', status: {topic: 's'}}]},
            ]),
        );
        expect(compositeWithoutFeature.warnings.map((w) => w.message)).toEqual([
            expect.stringContaining('ColorControl is not part of DimmableLight'),
        ]);
        expect(compositeWithoutFeature.ok).toBe(true);
    });

    it('checks map values, defaults, types and format keys against the attribute', () => {
        const result = validateDevice(
            device([
                {
                    deviceTypes: ['Thermostat', 'OnOffLight'],
                    mappings: [
                        {attribute: 'OnOff.onOff', status: {topic: 's', map: {ON: 1}}},
                        {
                            attribute: 'Thermostat.systemMode',
                            status: {topic: 's', map: {heat: 'Warm'}},
                            command: {topic: 'c', format: {Toasty: 'x'}},
                        },
                        {
                            attribute: 'Thermostat.thermostatRunningState',
                            status: {topic: 's', map: {heat: 'heat,grill'}},
                        },
                        {attribute: 'Thermostat.localTemperature', status: {topic: 's', type: 'boolean'}},
                        {attribute: 'LevelControl.currentLevel', status: {topic: 's', map: {a: 2.5}}},
                        {
                            attribute: 'Thermostat.occupiedHeatingSetpoint',
                            status: {topic: 's'},
                            command: {topic: 'c', optimistic: false},
                        },
                        {attribute: 'OnOff.onOff', status: {topic: 's2', template: '{{ value', type: 'boolean'}},
                        {invoke: 'WindowCovering.stopMotion', command: {topic: 'c'}},
                    ],
                },
            ]),
        );
        const errors = result.errors.map((e) => `${e.path}: ${e.message}`);
        expect(errors).toEqual([
            expect.stringContaining('mappings[0].status.map["ON"]: map value 1: the attribute is a boolean'),
            expect.stringContaining('mappings[1].status.map["heat"]: map value "Warm" is not one of'),
            expect.stringContaining('mappings[1].command.format: "Toasty" is not one of'),
            expect.stringContaining('mappings[2].status.map["heat"]: map value "grill" is not one of'),
            expect.stringContaining('mappings[3].status.type: type boolean, but the attribute is a integer'),
            expect.stringContaining('mappings[6].status.template'),
        ]);
        const warnings = result.warnings.map((w) => `${w.path}: ${w.message}`);
        expect(warnings).toEqual([
            expect.stringContaining('mappings[4].status.map["a"]: map value 2.5 is rounded'),
            expect.stringContaining('mappings[5].command.optimistic'),
            expect.stringContaining('mappings[6]: OnOff.onOff is bound twice'),
            expect.stringContaining('mappings[7]: cluster WindowCovering is not part of'),
            expect.stringContaining('mappings[7].command: no payload, template or format'),
        ]);
    });

    it("knows a derived cluster's own enum members and the base's commands (RvcOperationalState)", () => {
        const result = validateDevice(
            device([
                {
                    deviceTypes: ['RoboticVacuumCleaner'],
                    mappings: [
                        {
                            attribute: 'RvcOperationalState.operationalState',
                            status: {topic: 's', map: {docked: 'Docked', returning: 'SeekingCharger', idle: 'Stopped'}},
                        },
                        {invoke: 'RvcOperationalState.pause', command: {topic: 'c', payload: 'PAUSE'}},
                        {invoke: 'RvcOperationalState.goHome', command: {topic: 'c', payload: 'HOME'}},
                    ],
                },
            ]),
        );
        expect(result.issues).toEqual([]);
    });

    it('takes null in a map or default only for a nullable attribute', () => {
        const result = validateDevice(
            device([
                {
                    deviceTypes: ['Fan'],
                    features: {FanControl: ['Auto']},
                    mappings: [
                        {attribute: 'FanControl.percentSetting', status: {topic: 's', map: {auto: null, '1': 50}}},
                        {attribute: 'FanControl.fanMode', status: {topic: 's', map: {auto: 'Auto'}, default: null}},
                    ],
                },
            ]),
        );
        expect(result.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
            expect.stringContaining('mappings[1].status.default: default null: the attribute is not nullable'),
        ]);
    });

    it('warns about utility-only endpoints and refuses equal availability payloads', () => {
        const result = validateDevice(
            device([{deviceTypes: ['PowerSource'], mappings: []}], {
                availability: {topic: 'a', online: 'x', offline: 'x'},
            }),
        );
        expect(result.warnings.map((w) => w.message)).toEqual([expect.stringContaining('utility type')]);
        expect(result.errors.map((e) => e.message)).toEqual([expect.stringContaining('the same')]);
    });
});
