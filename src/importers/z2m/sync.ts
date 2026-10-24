/* The Zigbee2MQTT importer's API — plain functions over a `devices` record as it stands in the file:

   - `discover(payloads)`: what zigbee2mqtt describes, each with its generated baseline or the reason it
     cannot be adopted;
   - `diff(discovery, devices)`: what adopting would do — new, unchanged, updated (with the conflicts between
     the user's edits and the new baseline), orphaned, restored;
   - `adopt(devices, discovery, options)`: the new `devices` record plus that report; every z2m device
     is re-synced, selected new ones are added, missing ones are marked orphaned — never removed;
   - `orphaned(devices)`: the keys marked orphaned.

   The report, the re-sync and the orphaning are the generic importer sync (`../sync.ts`); this file brings
   zigbee2mqtt's discovery and its `source.raw`. The caller (the command line, the server for the UI)
   decides when to run it: on every retained `bridge/devices` / `bridge/groups` is the idea. */

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
    DEFAULT_BASE_TOPIC,
    deviceKey,
    generate,
    generateDevice,
    generateGroup,
    groupKey,
    groupUnsupportedReason,
    isRaw,
    type Raw,
    rawDevice,
    rawGroup,
    rawHash,
    unsupportedReason,
} from './generate.ts';
import type {BridgeDevice, BridgeGroup} from './types.ts';

export type {AdoptOptions, AdoptResult, Discovered, SyncEntry, SyncStatus};

export interface Discovery {
    baseTopic: string;
    items: Discovered[];
    /** a `bridge/devices` payload was seen: devices missing from it are orphaned */
    sawDevices: boolean;
    sawGroups: boolean;
}

export interface DiscoverInput {
    devices?: BridgeDevice[] | undefined;
    groups?: BridgeGroup[] | undefined;
    baseTopic?: string | undefined;
}

export function discover(input: DiscoverInput): Discovery {
    const baseTopic = input.baseTopic ?? DEFAULT_BASE_TOPIC;
    const items: Discovered[] = [];
    const byIeee = new Map<string, BridgeDevice>();
    for (const device of input.devices ?? []) {
        byIeee.set(device.ieee_address, device);
        const base = {
            key: deviceKey(device.ieee_address),
            kind: 'device' as const,
            name: device.friendly_name,
            ...(device.definition?.vendor === undefined ? {} : {vendor: device.definition.vendor}),
            ...(device.definition?.model === undefined ? {} : {model: device.definition.model}),
            ...(device.definition?.description === undefined ? {} : {description: device.definition.description}),
        };
        const reason = unsupportedReason(device);
        if (reason !== undefined) {
            items.push({...base, supported: false, reason, unmapped: []});
            continue;
        }
        const generated = generateDevice(rawDevice(device, baseTopic));
        if (generated === undefined) {
            items.push({...base, supported: false, reason: 'nothing of its exposes maps onto Matter', unmapped: []});
            continue;
        }
        items.push({...base, supported: true, baseline: generated.device, unmapped: generated.unmapped});
    }
    // a group's union needs its members' descriptions: without bridge/devices the groups are not evaluable
    const groups = input.devices === undefined ? undefined : input.groups;
    for (const group of groups ?? []) {
        const raw = rawGroup(group, byIeee, baseTopic);
        const base = {key: groupKey(group.id), kind: 'group' as const, name: group.friendly_name};
        const reason = groupUnsupportedReason(raw.union);
        const generated = reason === undefined ? generateGroup(raw) : undefined;
        if (generated === undefined) {
            items.push({...base, supported: false, reason: reason ?? 'nothing to map', unmapped: []});
            continue;
        }
        items.push({...base, supported: true, baseline: generated.device, unmapped: generated.unmapped});
    }
    return {baseTopic, items, sawDevices: input.devices !== undefined, sawGroups: groups !== undefined};
}

const sync = new Sync<Raw>({
    kind: 'z2m',
    isRaw,
    generate,
    kindOf: (key, raw) => raw?.kind ?? (key.startsWith('z2m:group:') ? 'group' : 'device'),
});

function syncDiscovery(discovery: Discovery): SyncDiscovery {
    return {
        items: discovery.items,
        seen: (kind) => (kind === 'group' ? discovery.sawGroups : discovery.sawDevices),
        notSeenNote: (kind) =>
            `no bridge/${kind === 'group' ? 'groups (with bridge/devices)' : 'devices'} seen; cannot tell`,
    };
}

export function isZ2mDevice(device: DeviceInput): boolean {
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

/** has the description behind `source.raw` changed against `source.version`? */
export function versionOf(raw: Raw): string {
    return rawHash(raw);
}
