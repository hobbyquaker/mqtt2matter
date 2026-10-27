/* The fan family: FanControl. Controllers write `fanMode` and `percentSetting` (attribute writes, so they
   are applied before we see them and routed by the generic write path); the family keeps the attributes
   consistent — a percent write sets `percentCurrent` and derives `fanMode`, a mode write derives the
   percent and publishes it when only the percent is bound — and does the same for the device's reports. */

import {FanControlServer as BaseFanControlServer} from '@matter/main/behaviors/fan-control';
import {FanControl} from '@matter/main/clusters/fan-control';

import type {Decoded} from '../engine/payload.ts';
import {type FamilyContext, hasCommand, hasStatus, route} from './registry.ts';

export const FAN_MODE_KEY = 'FanControl.fanMode';
export const PERCENT_SETTING_KEY = 'FanControl.percentSetting';
export const PERCENT_CURRENT_KEY = 'FanControl.percentCurrent';
export const SPEED_SETTING_KEY = 'FanControl.speedSetting';
export const SPEED_CURRENT_KEY = 'FanControl.speedCurrent';

/** the fan modes as the numbers they are on the wire (FanControl.FanMode) */
const MODE: Record<'off' | 'low' | 'medium' | 'high', number> = {
    off: FanControl.FanMode.Off,
    low: FanControl.FanMode.Low,
    medium: FanControl.FanMode.Medium,
    high: FanControl.FanMode.High,
};

export class FanControlServer extends BaseFanControlServer {}

export function percentToMode(context: FamilyContext, percent: number): number {
    if (percent <= 0) {
        return MODE.off;
    }
    const {low, medium} = context.options.fan;
    if (percent <= low) {
        return MODE.low;
    }
    if (percent <= medium) {
        return MODE.medium;
    }
    return MODE.high;
}

export function modeToPercent(context: FamilyContext, mode: number): number | undefined {
    const {low, medium} = context.options.fan;
    switch (mode) {
        case MODE.off:
            return 0;
        case MODE.low:
            return low;
        case MODE.medium:
            return medium;
        case MODE.high:
            return 100;
        default:
            return undefined;
    }
}

function fanState(context: FamilyContext): Record<string, unknown> {
    return (context.endpoint.state as Record<string, unknown>).fanControl as Record<string, unknown>;
}

async function setFan(context: FamilyContext, patch: Record<string, unknown>): Promise<void> {
    await context.endpoint.set({fanControl: patch} as never);
}

function speedPatch(context: FamilyContext, percent: number): Record<string, unknown> {
    const speedMax = context.options.fan.speedMax;
    if (speedMax <= 0) {
        return {};
    }
    const speed = Math.round((percent / 100) * speedMax);
    return {speedSetting: speed, speedCurrent: speed};
}

/** a controller wrote `fanMode` or `percentSetting` (already applied): keep the rest consistent, publish the rest */
export async function fanWrite(context: FamilyContext, attribute: string, value: unknown): Promise<void> {
    if (attribute === 'percentSetting' && typeof value === 'number') {
        const patch: Record<string, unknown> = {percentCurrent: value, ...speedPatch(context, value)};
        if (!hasCommand(context, FAN_MODE_KEY)) {
            patch.fanMode = percentToMode(context, value);
        }
        await setFan(context, patch);
        return;
    }
    if (attribute === 'fanMode' && typeof value === 'number') {
        const percent = modeToPercent(context, value);
        if (percent === undefined) {
            return;
        }
        const patch: Record<string, unknown> = {};
        if (!hasCommand(context, PERCENT_SETTING_KEY)) {
            patch.percentSetting = percent;
            patch.percentCurrent = percent;
            Object.assign(patch, speedPatch(context, percent));
        } else if (!hasCommand(context, FAN_MODE_KEY)) {
            // only the percent reaches the device: publish the mode's percent
            await route(context.endpoint, PERCENT_SETTING_KEY, percent, {percent, mode: value});
            patch.percentSetting = percent;
            patch.percentCurrent = percent;
            Object.assign(patch, speedPatch(context, percent));
        }
        if (Object.keys(patch).length > 0) {
            await setFan(context, patch);
        }
        return;
    }
    if (attribute === 'speedSetting' && typeof value === 'number' && context.options.fan.speedMax > 0) {
        const percent = Math.round((value / context.options.fan.speedMax) * 100);
        const patch: Record<string, unknown> = {speedCurrent: value};
        if (!hasCommand(context, PERCENT_SETTING_KEY)) {
            patch.percentSetting = percent;
            patch.percentCurrent = percent;
        } else {
            await route(context.endpoint, PERCENT_SETTING_KEY, percent, {percent, speed: value});
            patch.percentSetting = percent;
            patch.percentCurrent = percent;
        }
        if (!hasCommand(context, FAN_MODE_KEY)) {
            patch.fanMode = percentToMode(context, percent);
        }
        await setFan(context, patch);
    }
}

/** the device reported: a percent sets setting and current (and the mode unless bound), a mode the percent */
export async function fanStatus(
    context: FamilyContext | undefined,
    attribute: string,
    value: Decoded,
): Promise<boolean> {
    if (context === undefined) {
        return false;
    }
    if ((attribute === 'percentCurrent' || attribute === 'percentSetting') && typeof value === 'number') {
        const patch: Record<string, unknown> = {
            percentCurrent: value,
            percentSetting: value,
            ...speedPatch(context, value),
        };
        // a reported mode wins, except Auto: a fan in Auto reports no percent setting (null), so a percent means
        // it left Auto even when the mode's own report says nothing (Home Assistant's preset None)
        if (!hasStatus(context, FAN_MODE_KEY) || fanState(context).fanMode === FanControl.FanMode.Auto) {
            patch.fanMode = percentToMode(context, value);
        }
        await setFan(context, patch);
        return true;
    }
    if (attribute === 'fanMode' && typeof value === 'number') {
        const patch: Record<string, unknown> = {fanMode: value};
        const current = fanState(context);
        if (!hasStatus(context, PERCENT_CURRENT_KEY) && !hasStatus(context, PERCENT_SETTING_KEY)) {
            const percent = modeToPercent(context, value);
            if (percent !== undefined) {
                patch.percentSetting = percent;
                patch.percentCurrent = percent;
                Object.assign(patch, speedPatch(context, percent));
            }
        } else if (value === MODE.off && current.percentCurrent !== 0) {
            patch.percentSetting = 0;
            patch.percentCurrent = 0;
        }
        await setFan(context, patch);
        return true;
    }
    return false;
}
