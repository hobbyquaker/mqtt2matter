/* The families as the Matter layer uses them: per cluster the server class that routes controller
   commands, the features the mappings imply, the attribute defaults an endpoint needs, the status hook
   that translates composites and keeps the cluster consistent, the write hook for attributes controllers
   write, and the event channels. Everything stateful about a cluster lives in its family; the bridge only
   dispatches. */

import type {Behavior} from '@matter/main';

import type {Decoded} from '../engine/payload.ts';
import type {Options} from '../model/options.ts';
import {climateDefaults, climateFeatures, ThermostatServer} from './climate.ts';
import {coverStatus, WindowCoveringServer} from './cover.ts';
import {FanControlServer, fanStatus, fanWrite} from './fan.ts';
import {ColorControlServer, colorStatusPatch, LevelControlServer} from './light.ts';
import {DoorLockServer} from './lock.ts';
import {OnOffServer} from './on-off.ts';
import {powerSourceDefaults, powerSourceStatus, PowerSourceServer} from './power-source.ts';
import type {FamilyContext} from './registry.ts';
import {operationalStateDefaults, RvcOperationalStateServer, RvcRunModeServer, runModeDefaults} from './rvc.ts';
import {SwitchServer, switchEvent} from './switch.ts';

export interface Family {
    cluster: string;
    server: Behavior.Type;
    /** features the mappings imply (`Thermostat` from the setpoints); titles */
    features?: (boundKeys: ReadonlySet<string>, options: Options) => string[];
    /** attribute defaults for the endpoint's construction */
    defaults?: (features: ReadonlySet<string>, options: Options) => Record<string, unknown>;
    /** a status for an attribute of the cluster: a state patch for the cluster, true when applied itself, or false */
    status?: (
        context: FamilyContext | undefined,
        attribute: string,
        value: Decoded,
    ) => Promise<Record<string, unknown> | boolean>;
    /** a controller wrote a writable attribute (already applied) */
    write?: (context: FamilyContext, attribute: string, value: unknown) => Promise<void>;
    /** writable attributes the family watches even without a mapping (the fan derives one from the other) */
    writes?: readonly string[];
    /** the event channel of the cluster */
    event?: (context: FamilyContext, value: Decoded) => Promise<void>;
}

export const FAMILIES: readonly Family[] = [
    {cluster: 'OnOff', server: OnOffServer},
    {
        cluster: 'LevelControl',
        server: LevelControlServer,
    },
    {
        cluster: 'ColorControl',
        server: ColorControlServer,
        features: (bound) => {
            const features: string[] = [];
            if (bound.has('ColorControl.colorTemperatureMireds')) {
                features.push('ColorTemperature');
            }
            if (bound.has('ColorControl.colorHs') || bound.has('ColorControl.currentHue')) {
                features.push('HueSaturation');
            }
            if (bound.has('ColorControl.colorXy') || bound.has('ColorControl.currentX')) {
                features.push('Xy');
            }
            return features;
        },
        defaults: (features, options) => {
            const mode = features.has('ColorTemperature') ? 2 : features.has('HueSaturation') ? 0 : 1;
            return {
                colorMode: mode,
                enhancedColorMode: mode,
                ...(features.has('ColorTemperature')
                    ? {
                          colorTempPhysicalMinMireds: options.light.minMireds,
                          colorTempPhysicalMaxMireds: options.light.maxMireds,
                          coupleColorTempToLevelMinMireds: options.light.minMireds,
                          colorTemperatureMireds: Math.round((options.light.minMireds + options.light.maxMireds) / 2),
                      }
                    : {}),
            };
        },
        status: (context, attribute, value) => Promise.resolve(colorStatusPatch(context, attribute, value) ?? false),
    },
    {
        cluster: 'WindowCovering',
        server: WindowCoveringServer,
        features: (bound) => {
            const features: string[] = [];
            if (
                bound.has('WindowCovering.currentPositionLiftPercent100ths') ||
                bound.has('WindowCovering.targetPositionLiftPercent100ths')
            ) {
                features.push('Lift', 'PositionAwareLift');
            }
            if (
                bound.has('WindowCovering.currentPositionTiltPercent100ths') ||
                bound.has('WindowCovering.targetPositionTiltPercent100ths')
            ) {
                features.push('Tilt', 'PositionAwareTilt');
            }
            if (features.length === 0) {
                features.push('Lift');
            }
            return features;
        },
        defaults: (features) => ({
            type: features.has('Tilt') && !features.has('Lift') ? 7 : features.has('Tilt') ? 8 : 0,
            operationalStatus: {global: 0, lift: 0, tilt: 0},
            ...(features.has('PositionAwareLift')
                ? {currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0}
                : {}),
            ...(features.has('PositionAwareTilt')
                ? {currentPositionTiltPercent100ths: 0, targetPositionTiltPercent100ths: 0}
                : {}),
        }),
        status: coverStatus,
    },
    {
        cluster: 'Thermostat',
        server: ThermostatServer,
        features: (bound) => climateFeatures(bound),
        defaults: (features, options) => climateDefaults(features, options.climate),
    },
    {cluster: 'DoorLock', server: DoorLockServer},
    {
        cluster: 'FanControl',
        server: FanControlServer,
        features: (bound, options) => {
            const features: string[] = [];
            if (options.fan.speedMax > 0 || bound.has('FanControl.speedSetting')) {
                features.push('MultiSpeed');
            }
            return features;
        },
        defaults: (features, options) => ({
            fanModeSequence: features.has('Auto') ? 2 : 0,
            percentSetting: 0,
            percentCurrent: 0,
            ...(features.has('MultiSpeed')
                ? {speedMax: Math.max(1, options.fan.speedMax), speedSetting: 0, speedCurrent: 0}
                : {}),
        }),
        status: fanStatus,
        write: fanWrite,
        writes: ['fanMode', 'percentSetting', 'speedSetting'],
    },
    {
        cluster: 'Switch',
        server: SwitchServer,
        features: (_bound, options) =>
            options.switch.kind === 'latching'
                ? ['LatchingSwitch']
                : [
                      'MomentarySwitch',
                      'MomentarySwitchRelease',
                      'MomentarySwitchLongPress',
                      'MomentarySwitchMultiPress',
                  ],
        defaults: (features, options) => ({
            numberOfPositions: options.switch.numberOfPositions,
            currentPosition: 0,
            ...(features.has('MomentarySwitchMultiPress')
                ? {multiPressMax: options.switch.multiPressMax, multiPressDelay: options.switch.multiPressDelay}
                : {}),
            ...(features.has('MomentarySwitchLongPress') ? {longPressDelay: options.switch.longPressDelay} : {}),
        }),
        event: switchEvent,
    },
    {
        cluster: 'PowerSource',
        server: PowerSourceServer,
        features: (bound) => {
            if (bound.has('PowerSource.wiredCurrentType')) {
                return ['Wired'];
            }
            return ['Battery'];
        },
        defaults: (features) => powerSourceDefaults(features),
        status: powerSourceStatus,
    },
    {cluster: 'RvcRunMode', server: RvcRunModeServer, defaults: () => runModeDefaults()},
    {cluster: 'RvcOperationalState', server: RvcOperationalStateServer, defaults: () => operationalStateDefaults()},
];

export function familyFor(cluster: string): Family | undefined {
    return FAMILIES.find((f) => f.cluster === cluster);
}

export {registerContext, forgetContext, contextOf, type FamilyContext} from './registry.ts';
export {OnOffServer} from './on-off.ts';
export {LevelControlServer, ColorControlServer} from './light.ts';
export {WindowCoveringServer} from './cover.ts';
export {ThermostatServer} from './climate.ts';
export {DoorLockServer} from './lock.ts';
export {FanControlServer} from './fan.ts';
export {SwitchServer} from './switch.ts';
export {PowerSourceServer} from './power-source.ts';
export {RvcRunModeServer, RvcOperationalStateServer} from './rvc.ts';
