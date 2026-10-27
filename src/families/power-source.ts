/* The power source family: PowerSource on the same endpoint (device type `PowerSource`, feature `Battery`
   or `Wired`). Status is plain attributes — `batPercentRemaining` in Matter's half percents (bind with
   `unit: halfPercent`), `batVoltage` in mV (`unit: volt`), `batChargeLevel` by name — plus one derivation:
   the charge level from the percentage when it is not bound itself. */

import {PowerSourceServer as BasePowerSourceServer} from '@matter/main/behaviors/power-source';
import {PowerSource} from '@matter/main/clusters/power-source';

import type {Decoded} from '../engine/payload.ts';
import {type FamilyContext, hasStatus} from './registry.ts';

export const BAT_CHARGE_LEVEL_KEY = 'PowerSource.batChargeLevel';

export class PowerSourceServer extends BasePowerSourceServer {}

export function chargeLevelFor(context: FamilyContext, halfPercent: number): PowerSource.BatChargeLevel {
    const percent = halfPercent / 2;
    const {warning, critical} = context.options.powerSource;
    if (percent <= critical) {
        return PowerSource.BatChargeLevel.Critical;
    }
    if (percent <= warning) {
        return PowerSource.BatChargeLevel.Warning;
    }
    return PowerSource.BatChargeLevel.Ok;
}

/** the status side; true = handled */
export async function powerSourceStatus(
    context: FamilyContext | undefined,
    attribute: string,
    value: Decoded,
): Promise<boolean> {
    if (context === undefined || attribute !== 'batPercentRemaining' || typeof value !== 'number') {
        return false;
    }
    const patch: Record<string, unknown> = {batPercentRemaining: value};
    if (!hasStatus(context, BAT_CHARGE_LEVEL_KEY) && context.features.get('PowerSource')?.has('Battery') === true) {
        patch.batChargeLevel = chargeLevelFor(context, value);
    }
    await context.endpoint.set({powerSource: patch} as never);
    return true;
}

/** the attribute defaults a PowerSource endpoint needs beyond matter.js' own */
export function powerSourceDefaults(features: ReadonlySet<string>): Record<string, unknown> {
    const defaults: Record<string, unknown> = {
        status: PowerSource.PowerSourceStatus.Active,
        order: 0,
    };
    if (features.has('Battery')) {
        defaults.description = 'Battery';
        defaults.batChargeLevel = PowerSource.BatChargeLevel.Ok;
        defaults.batReplacementNeeded = false;
        defaults.batReplaceability = PowerSource.BatReplaceability.Unspecified;
        if (features.has('Rechargeable')) {
            // mandatory with the feature: Unknown until the first report
            defaults.batChargeState = PowerSource.BatChargeState.Unknown;
            defaults.batFunctionalWhileCharging = true;
        }
    } else if (features.has('Wired')) {
        defaults.description = 'Mains';
        defaults.wiredCurrentType = PowerSource.WiredCurrentType.Ac;
    } else {
        defaults.description = 'Power';
    }
    return defaults;
}
