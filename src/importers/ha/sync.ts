/* The Home Assistant discovery importer's API, the same shape as the zigbee2mqtt importer's:

   - `discover({entities, prefix, seen})`: the entities grouped by their Home Assistant device, each
     device with its generated baseline or the reason it cannot be adopted;
   - `diff(discovery, devices)`, `adopt(devices, discovery, options)`, `orphaned(devices)`, `edits(device)`:
     the generic importer sync (`../sync.ts`) over `source.kind: "ha-discovery"`.

   A device is keyed `ha:<first identifier or connection>`; an entity without a device block is listed as
   unsupported (Home Assistant itself requires `device` and `unique_id` for an entity to be grouped). A
   device that zigbee2mqtt announces through its own discovery is marked `native` with the zigbee2mqtt
   importer's key: the native description is preferred. */

import {createHash} from 'node:crypto';

import type {DeviceInput, DevicesInput} from '../../model/index.ts';
import type {editsOf} from '../patch.ts';
import {
    type AdoptOptions,
    type AdoptResult,
    type Discovered,
    Sync,
    type SyncDiscovery,
    type SyncEntry,
    type SyncStatus,
} from '../sync.ts';
import {
    deviceKey,
    generate,
    generateReport,
    isRaw,
    nativeKey,
    type RawDevice,
    type RawEntity,
    rawHash,
    trimConfig,
    trimDevice,
    trimOrigin,
} from './generate.ts';
import type {Entity} from './source.ts';
import {deviceIdentity} from './types.ts';

export type {AdoptOptions, AdoptResult, Discovered, SyncEntry, SyncStatus};

export interface Discovery {
    prefix: string;
    items: Discovered[];
    /** a discovery message was seen: devices missing from the view are orphaned */
    seen: boolean;
}

export interface DiscoverInput {
    entities: Entity[];
    prefix?: string | undefined;
    seen?: boolean | undefined;
}

/** the raw description of one Home Assistant device from its entities, in a stable order */
export function rawDevice(prefix: string, identity: string, entities: Entity[]): RawDevice {
    const sorted = [...entities].sort((a, b) => a.id.localeCompare(b.id));
    // every entity repeats the device block, often only its identifiers: the first value per field wins
    const merged: Record<string, unknown> = {};
    for (const entity of sorted) {
        for (const [key, value] of Object.entries(entity.config.device ?? {})) {
            if (merged[key] === undefined && value !== undefined && value !== null && value !== '') {
                merged[key] = value;
            }
        }
    }
    const device = trimDevice(merged);
    const origin = trimOrigin(sorted.find((e) => e.config.origin !== undefined)?.config.origin);
    const raw: RawDevice = {
        kind: 'ha',
        prefix,
        identity,
        device,
        ...(origin === undefined ? {} : {origin}),
        entities: sorted.map((e): RawEntity => ({
            id: e.objectId,
            topic: e.topic,
            component: e.component,
            config: trimConfig(e.config),
        })),
    };
    return raw;
}

export function discover(input: DiscoverInput): Discovery {
    const prefix = input.prefix ?? 'homeassistant';
    const items: Discovered[] = [];
    const byIdentity = new Map<string, Entity[]>();
    for (const entity of input.entities) {
        const identity = deviceIdentity(entity.config.device);
        if (identity === undefined) {
            const hash = createHash('sha256').update(entity.id).digest('hex').slice(0, 12);
            const name = typeof entity.config.name === 'string' ? entity.config.name : entity.objectId;
            items.push({
                key: `ha:entity:${hash}`,
                kind: 'device',
                name: `${entity.component} ${name}`,
                supported: false,
                reason: 'no device block: an entity without a device cannot be adopted',
                unmapped: [],
            });
            continue;
        }
        let group = byIdentity.get(identity);
        if (group === undefined) {
            group = [];
            byIdentity.set(identity, group);
        }
        group.push(entity);
    }
    for (const [identity, entities] of byIdentity) {
        const raw = rawDevice(prefix, identity, entities);
        const area = typeof raw.device.suggested_area === 'string' ? raw.device.suggested_area.trim() : '';
        const native = nativeKey(identity, raw.origin);
        const base = {
            key: deviceKey(identity),
            kind: 'device' as const,
            name: raw.device.name ?? identity,
            ...(raw.device.manufacturer === undefined ? {} : {vendor: raw.device.manufacturer}),
            ...(raw.device.model === undefined ? {} : {model: raw.device.model}),
            ...(area === '' ? {} : {area}),
            ...(native === undefined ? {} : {native}),
        };
        const generated = generateReport(raw);
        if (generated.device === undefined) {
            items.push({
                ...base,
                supported: false,
                reason: 'nothing of its entities maps onto Matter',
                unmapped: generated.unmapped,
            });
            continue;
        }
        items.push({...base, supported: true, baseline: generated.device, unmapped: generated.unmapped});
    }
    return {prefix, items, seen: input.seen ?? true};
}

const sync = new Sync<RawDevice>({
    kind: 'ha-discovery',
    isRaw,
    generate,
    kindOf: () => 'device',
});

function syncDiscovery(discovery: Discovery): SyncDiscovery {
    return {
        items: discovery.items,
        seen: () => discovery.seen,
        notSeenNote: () => 'no discovery message seen yet; cannot tell',
    };
}

export function isHaDevice(device: DeviceInput): boolean {
    return sync.isOwn(device);
}

export function orphaned(devices: DevicesInput): string[] {
    return sync.orphaned(devices);
}

/** what adopting the discovery onto `devices` would do, entry by entry */
export function diff(discovery: Discovery, devices: DevicesInput): SyncEntry[] {
    return sync.diff(syncDiscovery(discovery), devices);
}

/** the `devices` record after adopting: existing entries in place and order, new ones appended */
export function adopt(devices: DevicesInput, discovery: Discovery, options: AdoptOptions = {}): AdoptResult {
    return sync.adopt(devices, syncDiscovery(discovery), options);
}

/** the user's edits of a device against its baseline; empty when it is untouched or has no baseline */
export function edits(device: DeviceInput): ReturnType<typeof editsOf> {
    return sync.edits(device);
}

export function versionOf(raw: RawDevice): string {
    return rawHash(raw);
}
