/* The climate family: Thermostat. Its features follow the bound setpoints — Heating when
   `occupiedHeatingSetpoint` is bound, Cooling when `occupiedCoolingSetpoint` is, AutoMode when both are
   and `systemMode` is bound — unless the config names them. Setpoints and `systemMode` are attribute
   writes: matter.js applies them, the generic write path publishes them. Temperatures are Matter's 0.01 °C
   (bind with `unit: celsius` or `fahrenheit`); the limits and the dead band come from the options.
   `thermostatRunningState` is a bitmap written by field names (`heat`, `cool`, `fan`). */

import {ThermostatServer as BaseThermostatServer} from '@matter/main/behaviors/thermostat';
import {Thermostat} from '@matter/main/clusters/thermostat';

import type {Options} from '../model/options.ts';

export class ThermostatServer extends BaseThermostatServer {}

export const HEATING_SETPOINT_KEY = 'Thermostat.occupiedHeatingSetpoint';
export const COOLING_SETPOINT_KEY = 'Thermostat.occupiedCoolingSetpoint';
export const SYSTEM_MODE_KEY = 'Thermostat.systemMode';

/** the Thermostat features the bound attributes imply */
export function climateFeatures(boundKeys: ReadonlySet<string>): string[] {
    const features: string[] = [];
    const heating = boundKeys.has(HEATING_SETPOINT_KEY);
    const cooling = boundKeys.has(COOLING_SETPOINT_KEY);
    if (heating) {
        features.push('Heating');
    }
    if (cooling) {
        features.push('Cooling');
    }
    if (heating && cooling && boundKeys.has(SYSTEM_MODE_KEY)) {
        features.push('AutoMode');
    }
    return features;
}

const c = (celsius: number): number => Math.round(celsius * 100);

/** the attribute defaults a thermostat endpoint needs: limits, control sequence, dead band, starting setpoints */
export function climateDefaults(features: ReadonlySet<string>, options: Options['climate']): Record<string, unknown> {
    const heating = features.has('Heating');
    const cooling = features.has('Cooling');
    const defaults: Record<string, unknown> = {
        localTemperature: null,
        controlSequenceOfOperation:
            heating && cooling
                ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
                : cooling
                  ? Thermostat.ControlSequenceOfOperation.CoolingOnly
                  : Thermostat.ControlSequenceOfOperation.HeatingOnly,
        systemMode: heating
            ? Thermostat.SystemMode.Heat
            : cooling
              ? Thermostat.SystemMode.Cool
              : Thermostat.SystemMode.Off,
    };
    if (heating) {
        defaults.absMinHeatSetpointLimit = c(options.minHeat);
        defaults.absMaxHeatSetpointLimit = c(options.maxHeat);
        defaults.minHeatSetpointLimit = c(options.minHeat);
        defaults.maxHeatSetpointLimit = c(options.maxHeat);
        defaults.occupiedHeatingSetpoint = c(Math.min(Math.max(20, options.minHeat), options.maxHeat));
    }
    if (cooling) {
        defaults.absMinCoolSetpointLimit = c(options.minCool);
        defaults.absMaxCoolSetpointLimit = c(options.maxCool);
        defaults.minCoolSetpointLimit = c(options.minCool);
        defaults.maxCoolSetpointLimit = c(options.maxCool);
        defaults.occupiedCoolingSetpoint = c(Math.min(Math.max(24, options.minCool), options.maxCool));
    }
    if (features.has('AutoMode')) {
        defaults.minSetpointDeadBand = Math.round(options.deadband * 10);
        defaults.thermostatRunningMode = Thermostat.ThermostatRunningMode.Off;
    }
    return defaults;
}
