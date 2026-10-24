/* The Zigbee2MQTT importer's API — plain functions over a `devices` record as it stands in the file:

   - `discover(payloads)`: what zigbee2mqtt describes, each with its generated baseline or the reason it
     cannot be adopted;
   - `diff(discovery, devices)`: what adopting would do — new, unchanged, updated (with the conflicts between
     the user's edits and the new baseline), orphaned, restored;
   - `adopt(devices, discovery, options)`: the new `devices` record plus that report; every z2m device
     is re-synced, selected new ones are added, missing ones are marked orphaned — never removed;
   - `orphaned(devices)`: the keys marked orphaned.

   The caller (the command line today, the server for the UI later) decides when to run it: on every
   retained `bridge/devices` / `bridge/groups` is the idea. */

import {type DeviceInput, type DevicesInput, DeviceSchema} from '../../model/index.ts';
import {type Conflict, deepEqual, editsOf, resync} from '../patch.ts';
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

export interface Discovered {
    key: string;
    kind: 'device' | 'group';
    name: string;
    vendor?: string;
    model?: string;
    description?: string;
    /** a baseline could be generated */
    supported: boolean;
    /** why not */
    reason?: string;
    baseline?: DeviceInput;
    /** exposes and action values without a Matter equivalent */
    unmapped: string[];
}

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

export type SyncStatus =
    /** described by zigbee2mqtt, not in the config */
    | 'new'
    | 'unchanged'
    /** the baseline changed; the user's edits were reapplied */
    | 'updated'
    /** gone from zigbee2mqtt; kept, marked */
    | 'orphaned'
    /** back in zigbee2mqtt after being orphaned */
    | 'restored'
    /** the merge of baseline and edits does not validate; the device was left as it was */
    | 'invalid'
    /** zigbee2mqtt describes it, but it cannot be adopted (or no longer can) */
    | 'unsupported';

export interface SyncEntry {
    key: string;
    kind: 'device' | 'group';
    name: string;
    status: SyncStatus;
    /** the device as it would be (is) after adopting; absent for unsupported ones not in the config */
    device?: DeviceInput;
    conflicts: Conflict[];
    /** how many edits of the user's were found and carried over */
    edits: number;
    unmapped: string[];
    /** reasons and validation messages */
    notes: string[];
}

export function isZ2mDevice(device: DeviceInput): boolean {
    return device.source?.kind === 'z2m';
}

export function orphaned(devices: DevicesInput): string[] {
    return Object.entries(devices)
        .filter(([, device]) => isZ2mDevice(device) && device.source?.orphaned === true)
        .map(([key]) => key);
}

function withoutSource(device: DeviceInput): Omit<DeviceInput, 'source'> {
    const rest: Partial<DeviceInput> = structuredClone(device);
    delete rest.source;
    return rest as Omit<DeviceInput, 'source'>;
}

/** the old baseline from `source.raw`, or undefined when it cannot be regenerated */
function oldBaselineOf(current: DeviceInput): DeviceInput | undefined {
    const raw: unknown = current.source?.raw;
    return isRaw(raw) ? generate(raw)?.device : undefined;
}

function validationNotes(device: DeviceInput): string[] {
    const parsed = DeviceSchema.safeParse(device);
    return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/** one config entry against its discovery */
function syncOne(key: string, current: DeviceInput, item: Discovered): SyncEntry {
    const base: Omit<SyncEntry, 'status'> = {
        key,
        kind: item.kind,
        name: item.name,
        conflicts: [],
        edits: 0,
        unmapped: item.unmapped,
        notes: [],
    };
    const wasOrphaned = current.source?.orphaned === true;
    const newBaseline = item.baseline;
    if (newBaseline === undefined) {
        return {...base, status: 'unsupported', device: current, notes: [item.reason ?? 'cannot be adopted']};
    }
    const oldBaseline = oldBaselineOf(current);
    if (oldBaseline === undefined) {
        // no baseline to tell the user's edits from: the device stays as it is, only the source is refreshed
        const device = structuredClone(current);
        device.source = structuredClone(newBaseline.source);
        return {
            ...base,
            status: wasOrphaned ? 'restored' : 'unchanged',
            device,
            notes: ['no baseline in source.raw; the device was kept as it is'],
        };
    }
    const result = resync(oldBaseline, current, newBaseline);
    const device = result.device;
    device.source = structuredClone(newBaseline.source);
    const notes = validationNotes(device);
    if (notes.length > 0) {
        const kept = structuredClone(current);
        if (kept.source !== undefined) {
            delete kept.source.orphaned;
        }
        return {
            ...base,
            status: 'invalid',
            device: kept,
            conflicts: result.conflicts,
            edits: result.edits.length,
            notes,
        };
    }
    const changed = !deepEqual(withoutSource(device), withoutSource(current));
    const status: SyncStatus = wasOrphaned ? 'restored' : changed ? 'updated' : 'unchanged';
    return {...base, status, device, conflicts: result.conflicts, edits: result.edits.length};
}

/** what adopting the discovery onto `devices` would do, entry by entry */
export function diff(discovery: Discovery, devices: DevicesInput): SyncEntry[] {
    const entries: SyncEntry[] = [];
    const byKey = new Map(discovery.items.map((item) => [item.key, item]));
    for (const [key, current] of Object.entries(devices)) {
        if (!isZ2mDevice(current)) {
            continue;
        }
        const item = byKey.get(key);
        if (item !== undefined) {
            entries.push(syncOne(key, current, item));
            byKey.delete(key);
            continue;
        }
        const raw: unknown = current.source?.raw;
        const kind: 'device' | 'group' = isRaw(raw) ? raw.kind : key.startsWith('z2m:group:') ? 'group' : 'device';
        const seen = kind === 'group' ? discovery.sawGroups : discovery.sawDevices;
        const device = structuredClone(current);
        if (seen) {
            device.source = {...(device.source ?? {kind: 'z2m'}), orphaned: true};
        }
        entries.push({
            key,
            kind,
            name: current.name,
            status: seen ? 'orphaned' : 'unchanged',
            device,
            conflicts: [],
            edits: 0,
            unmapped: [],
            notes: seen
                ? []
                : [`no bridge/${kind === 'group' ? 'groups (with bridge/devices)' : 'devices'} seen; cannot tell`],
        });
    }
    for (const item of byKey.values()) {
        entries.push({
            key: item.key,
            kind: item.kind,
            name: item.name,
            status: item.supported ? 'new' : 'unsupported',
            ...(item.baseline === undefined ? {} : {device: item.baseline}),
            conflicts: [],
            edits: 0,
            unmapped: item.unmapped,
            notes: item.reason === undefined ? [] : [item.reason],
        });
    }
    return entries;
}

export interface AdoptOptions {
    /** the new devices to add; default: every supported one */
    keys?: readonly string[] | undefined;
    /** re-sync the devices already in the config (default true) */
    resync?: boolean | undefined;
    /** mark the devices zigbee2mqtt no longer describes (default true) */
    orphan?: boolean | undefined;
}

export interface AdoptResult {
    devices: DevicesInput;
    report: SyncEntry[];
}

/** the `devices` record after adopting: existing entries in place and order, new ones appended */
export function adopt(devices: DevicesInput, discovery: Discovery, options: AdoptOptions = {}): AdoptResult {
    const report = diff(discovery, devices);
    const wanted = options.keys === undefined ? undefined : new Set(options.keys);
    const result: DevicesInput = {};
    const byKey = new Map(report.map((entry) => [entry.key, entry]));
    for (const [key, current] of Object.entries(devices)) {
        const entry = byKey.get(key);
        if (entry?.device === undefined) {
            result[key] = current;
            continue;
        }
        if (entry.status === 'orphaned' && options.orphan === false) {
            result[key] = current;
            entry.status = 'unchanged';
            continue;
        }
        if ((entry.status === 'updated' || entry.status === 'restored') && options.resync === false) {
            result[key] = current;
            entry.status = 'unchanged';
            continue;
        }
        result[key] = entry.device;
    }
    for (const entry of report) {
        if (entry.status !== 'new' || entry.device === undefined) {
            continue;
        }
        if (wanted !== undefined && !wanted.has(entry.key)) {
            continue;
        }
        result[entry.key] = entry.device;
    }
    return {devices: result, report};
}

/** the user's edits of a device against its baseline; empty when it is untouched or has no baseline */
export function edits(device: DeviceInput): ReturnType<typeof editsOf> {
    const baseline = oldBaselineOf(device);
    return baseline === undefined ? [] : editsOf(baseline, device);
}

/** has the description behind `source.raw` changed against `source.version`? */
export function versionOf(raw: Raw): string {
    return rawHash(raw);
}
