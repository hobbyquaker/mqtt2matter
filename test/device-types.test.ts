/* The endpoint builder, without a node: device types, clusters, features and defaults. */

import {describe, expect, it} from 'vitest';

import {EndpointSchema} from '../src/model/schema.ts';
import {boundKeys, buildEndpoint, deviceDefinition, supportedDeviceTypes} from '../src/matter/device-types.ts';

const endpoint = (raw: Record<string, unknown>) => EndpointSchema.parse(raw);

describe('buildEndpoint', () => {
    it('knows every device type matter.js ships, plus the power source', () => {
        const names = supportedDeviceTypes();
        expect(names).toEqual(
            expect.arrayContaining([
                'OnOffLight',
                'WindowCovering',
                'Thermostat',
                'GenericSwitch',
                'PowerSource',
                'AirQualitySensor',
            ]),
        );
        expect(deviceDefinition('OnOffLight')?.deviceType).toBe(0x100);
        expect(deviceDefinition('PowerSource')?.deviceType).toBe(0x11);
        expect(deviceDefinition('Nonsense')).toBeUndefined();
        expect(() => buildEndpoint(endpoint({deviceTypes: ['Nonsense']}))).toThrow(/not known/);
    });

    it('takes the mandatory clusters and features from the device type', () => {
        const built = buildEndpoint(endpoint({deviceTypes: ['DimmableLight']}));
        expect([...built.clusters.keys()]).toEqual(
            expect.arrayContaining(['Identify', 'Groups', 'OnOff', 'LevelControl']),
        );
        expect([...built.features.get('OnOff')!]).toEqual(['Lighting']);
        expect([...built.features.get('LevelControl')!].sort()).toEqual(['Lighting', 'OnOff']);
        expect(built.deviceTypeList).toEqual([{deviceType: 0x101, revision: expect.any(Number)}]);
        expect(built.defaults.descriptor).toBeUndefined();
    });

    it('adds optional and foreign clusters that bindings name, with the family features they imply', () => {
        const built = buildEndpoint(
            endpoint({
                deviceTypes: ['OnOffLight'],
                bindings: [
                    {attribute: 'LevelControl.currentLevel', status: {topic: 's'}},
                    {attribute: 'ColorControl.colorHs', status: {topic: 's'}},
                    {attribute: 'ColorControl.colorTemperatureMireds', status: {topic: 's'}},
                ],
            }),
        );
        expect(built.clusters.has('LevelControl')).toBe(true);
        expect(built.clusters.get('ColorControl')).toBe('colorControl');
        expect([...built.features.get('ColorControl')!].sort()).toEqual(['ColorTemperature', 'HueSaturation']);
        expect(built.defaults.colorControl).toMatchObject({colorMode: 2, colorTempPhysicalMinMireds: 153});
    });

    it('unions configured features and applies attribute overrides and cluster defaults', () => {
        const built = buildEndpoint(
            endpoint({
                deviceTypes: ['TemperatureSensor', 'PowerSource'],
                features: {PowerSource: ['Rechargeable']},
                attributes: {PowerSource: {description: 'AA'}},
                options: {powerSource: {warning: 30}},
                bindings: [{attribute: 'PowerSource.batPercentRemaining', status: {topic: 's'}}],
            }),
        );
        expect([...built.features.get('PowerSource')!].sort()).toEqual(['Battery', 'Rechargeable']);
        expect(built.defaults.powerSource).toMatchObject({description: 'AA', status: 1, batChargeLevel: 0});
        expect(built.defaults.temperatureMeasurement).toEqual({measuredValue: null});
        expect(built.defaults.descriptor?.deviceTypeList).toEqual([
            {deviceType: 0x302, revision: expect.any(Number)},
            {deviceType: 0x11, revision: expect.any(Number)},
        ]);
        expect(() =>
            buildEndpoint(
                endpoint({deviceTypes: ['TemperatureSensor'], features: {TemperatureMeasurement: ['Sparkle']}}),
            ),
        ).toThrow(/no feature "Sparkle"/);
    });

    it('derives the thermostat and cover features from the bindings', () => {
        const thermostat = buildEndpoint(
            endpoint({
                deviceTypes: ['Thermostat'],
                bindings: [
                    {attribute: 'Thermostat.occupiedHeatingSetpoint', status: {topic: 's'}},
                    {attribute: 'Thermostat.occupiedCoolingSetpoint', status: {topic: 's'}},
                    {attribute: 'Thermostat.systemMode', status: {topic: 's'}},
                ],
            }),
        );
        expect([...thermostat.features.get('Thermostat')!].sort()).toEqual(['AutoMode', 'Cooling', 'Heating']);
        expect(thermostat.defaults.thermostat).toMatchObject({
            controlSequenceOfOperation: 4,
            minSetpointDeadBand: 20,
            absMinHeatSetpointLimit: 700,
        });
        const cover = buildEndpoint(
            endpoint({
                deviceTypes: ['WindowCovering'],
                bindings: [{attribute: 'WindowCovering.currentPositionTiltPercent100ths', status: {topic: 's'}}],
            }),
        );
        expect([...cover.features.get('WindowCovering')!].sort()).toEqual(['PositionAwareTilt', 'Tilt']);
        const stateOnlyConfig = endpoint({
            deviceTypes: ['WindowCovering'],
            bindings: [{attribute: 'WindowCovering.motion', status: {topic: 's'}}],
        });
        const stateOnly = buildEndpoint(stateOnlyConfig);
        expect([...stateOnly.features.get('WindowCovering')!]).toEqual(['Lift']);
        expect(boundKeys(stateOnlyConfig)).toEqual(new Set(['WindowCovering.motion']));
    });

    it('switch options choose the switch features and delays', () => {
        const momentary = buildEndpoint(
            endpoint({deviceTypes: ['GenericSwitch'], options: {switch: {multiPressMax: 2}}}),
        );
        expect([...momentary.features.get('Switch')!]).toEqual([
            'MomentarySwitch',
            'MomentarySwitchRelease',
            'MomentarySwitchLongPress',
            'MomentarySwitchMultiPress',
        ]);
        expect(momentary.defaults.switch).toMatchObject({multiPressMax: 2, numberOfPositions: 2});
        const latching = buildEndpoint(
            endpoint({deviceTypes: ['GenericSwitch'], options: {switch: {kind: 'latching', numberOfPositions: 3}}}),
        );
        expect([...latching.features.get('Switch')!]).toEqual(['LatchingSwitch']);
        expect(latching.defaults.switch).toMatchObject({numberOfPositions: 3});
    });
});
