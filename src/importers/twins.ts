/* One physical device, two descriptions: zigbee2mqtt describes its devices natively (`bridge/devices`) and,
   when its Home Assistant integration is on, a second time through discovery. Both importers would make a
   Matter device of it. The twin of a device is the other importer's key for the same device; the native
   description is preferred, and the shared sync refuses to adopt a second one without an explicit `force`. */

import type {DeviceInput, DevicesInput} from '../model/index.ts';
import {isRaw as isHaRaw, nativeKey} from './ha/generate.ts';

/** the key of the native description a configured device is a twin of (`z2m:0x…`), or undefined */
export function nativeOfDevice(device: DeviceInput): string | undefined {
    if (device.source?.kind !== 'ha-discovery') {
        return undefined;
    }
    const raw: unknown = device.source.raw;
    return isHaRaw(raw) ? nativeKey(raw.identity, raw.device) : undefined;
}

/** does a configured device stand for its physical device on the bridge (not disabled, not orphaned)? */
export function isLive(device: DeviceInput): boolean {
    return device.enabled !== false && device.source?.orphaned !== true;
}

/**
 * The configured devices that describe the same physical device as `key` — the native one an HA device
 * names, and the HA devices that name `key` as theirs — without `key` itself.
 */
export function twinsOf(key: string, devices: DevicesInput, native?: string): string[] {
    const twins = new Set<string>();
    if (native !== undefined && native !== key && devices[native] !== undefined) {
        twins.add(native);
    }
    for (const [other, device] of Object.entries(devices)) {
        if (other !== key && nativeOfDevice(device) === key) {
            twins.add(other);
        }
    }
    return [...twins];
}
