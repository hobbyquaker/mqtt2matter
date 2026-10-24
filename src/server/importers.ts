/* The importers as the server sees them, and what the adopt page does with them. An importer knows a
   source (Zigbee2MQTT's `bridge/devices`, Home Assistant's discovery topics) and generates device
   entries of the manual model from it; this file compares those with the configured devices: new ones
   can be adopted, adopted ones show a diff when the source changed, and a device whose source entry
   disappeared is marked orphaned — never removed by itself (the user clicks). */

import {DEVICE_KEY_PATTERN, type DeviceConfig, type Source} from '../model/schema.ts';

export interface DiscoveredDevice {
    /** the source's key for the device (a z2m friendly name, a discovery object id) */
    key: string;
    name: string;
    vendor?: string | undefined;
    model?: string | undefined;
    /** the generated entry; its `source` names the importer's kind and `key` */
    device: DeviceConfig;
}

export interface Importer {
    readonly kind: Source['kind'];
    /** what the source currently describes */
    discovered(): readonly DiscoveredDevice[];
    /** read the source again */
    resync(): Promise<void>;
    /** called whenever `discovered()` would answer differently */
    onChange(listener: () => void): () => void;
}

export interface Change {
    path: string;
    before: unknown;
    after: unknown;
}

export type AdoptState = 'new' | 'adopted' | 'changed' | 'orphaned';

export interface AdoptEntry {
    kind: Source['kind'];
    /** the source's key */
    sourceKey: string;
    name: string;
    vendor?: string | undefined;
    model?: string | undefined;
    state: AdoptState;
    /** the device key the entry has or would get */
    deviceKey: string;
    /** `changed`: what the source would change on the configured device */
    changes?: Change[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** the differences between two JSON values, as paths */
export function diff(before: unknown, after: unknown, path = ''): Change[] {
    if (isRecord(before) && isRecord(after)) {
        const changes: Change[] = [];
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            changes.push(...diff(before[key], after[key], path === '' ? key : `${path}.${key}`));
        }
        return changes;
    }
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
        const changes: Change[] = [];
        before.forEach((item, index) => {
            changes.push(...diff(item, after[index], `${path}[${index}]`));
        });
        return changes;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) {
        return [];
    }
    return [{path, before, after}];
}

/** a device key from a source key: the characters the pattern allows, `_` for the rest */
export function deviceKeyFor(sourceKey: string, taken: ReadonlySet<string>): string {
    let key = sourceKey.replace(/[^A-Za-z0-9:._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
    if (key === '') {
        key = 'device';
    }
    key = key.slice(0, 64);
    if (!DEVICE_KEY_PATTERN.test(key)) {
        key = `device_${key}`.slice(0, 64);
    }
    let candidate = key;
    for (let n = 2; taken.has(candidate); n++) {
        const suffix = `_${n}`;
        candidate = `${key.slice(0, 64 - suffix.length)}${suffix}`;
    }
    return candidate;
}

/** the parts of a device the user does not own when it is adopted: everything but the source bookkeeping */
function comparable(device: DeviceConfig): unknown {
    const rest: Partial<DeviceConfig> = {...device};
    delete rest.source;
    delete rest.bridge;
    delete rest.enabled;
    return rest;
}

/** the adopt page's entries for every importer */
export function adoptEntries(
    devices: Readonly<Record<string, DeviceConfig>>,
    importers: readonly Importer[],
): AdoptEntry[] {
    const entries: AdoptEntry[] = [];
    const taken = new Set(Object.keys(devices));
    for (const importer of importers) {
        const seen = new Set<string>();
        for (const found of importer.discovered()) {
            seen.add(found.key);
            const configured = Object.entries(devices).find(
                ([, d]) => d.source.kind === importer.kind && d.source.key === found.key,
            );
            if (configured === undefined) {
                entries.push({
                    kind: importer.kind,
                    sourceKey: found.key,
                    name: found.name,
                    vendor: found.vendor,
                    model: found.model,
                    state: 'new',
                    deviceKey: deviceKeyFor(found.key, taken),
                });
                continue;
            }
            const [deviceKey, device] = configured;
            const changes = diff(comparable(device), comparable(found.device));
            entries.push({
                kind: importer.kind,
                sourceKey: found.key,
                name: device.name,
                vendor: found.vendor,
                model: found.model,
                state: changes.length > 0 ? 'changed' : 'adopted',
                deviceKey,
                ...(changes.length > 0 ? {changes} : {}),
            });
        }
        for (const [deviceKey, device] of Object.entries(devices)) {
            if (
                device.source.kind === importer.kind &&
                device.source.key !== undefined &&
                !seen.has(device.source.key)
            ) {
                entries.push({
                    kind: importer.kind,
                    sourceKey: device.source.key,
                    name: device.name,
                    vendor: device.vendor,
                    model: device.model,
                    state: 'orphaned',
                    deviceKey,
                });
            }
        }
    }
    return entries;
}

/** the device entry an adoption writes: the generated one, with the source recorded */
export function adoptedDevice(found: DiscoveredDevice, kind: Source['kind']): DeviceConfig {
    return {
        ...structuredClone(found.device),
        source: {...found.device.source, kind, key: found.key, orphaned: false},
    };
}
