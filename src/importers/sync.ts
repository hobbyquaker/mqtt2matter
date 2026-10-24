/* What every importer does with its discoveries, once: the report over a `devices` record (`diff`) and the
   adoption (`adopt`) — new entries added, known ones re-synced from their stored `source.raw` with the
   user's edits carried over and conflicts reported, missing ones marked orphaned and never removed,
   orphaned ones restored when they are back, manual devices untouched. An importer brings its kind, how
   to recognise and regenerate its `source.raw`, and its discovery; everything else is here. */

import {type DeviceInput, type DevicesInput, DeviceSchema, type SourceInput} from '../model/index.ts';
import {type Conflict, deepEqual, editsOf, resync} from './patch.ts';

export interface Generated {
    device: DeviceInput;
    /** what the description carries that has no Matter equivalent (shown, not dropped silently) */
    unmapped: string[];
}

export interface Discovered {
    key: string;
    /** `device` or `group` — what the UI shows as a badge */
    kind: 'device' | 'group';
    name: string;
    vendor?: string;
    model?: string;
    description?: string;
    /** the area the source suggests for the device (Home Assistant's `suggested_area`) */
    area?: string;
    /** the key of another importer's native description of the same device (`z2m:0x…`): native preferred */
    native?: string;
    /** a baseline could be generated */
    supported: boolean;
    /** why not */
    reason?: string;
    baseline?: DeviceInput;
    unmapped: string[];
}

export type SyncStatus =
    /** described by the source, not in the config */
    | 'new'
    | 'unchanged'
    /** the baseline changed; the user's edits were reapplied */
    | 'updated'
    /** gone from the source; kept, marked */
    | 'orphaned'
    /** back in the source after being orphaned */
    | 'restored'
    /** the merge of baseline and edits does not validate; the device was left as it was */
    | 'invalid'
    /** the source describes it, but it cannot be adopted (or no longer can) */
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
    area?: string;
    native?: string;
}

export interface AdoptOptions {
    /** the new devices to add; default: every supported one */
    keys?: readonly string[] | undefined;
    /** re-sync the devices already in the config (default true) */
    resync?: boolean | undefined;
    /** mark the devices the source no longer describes (default true) */
    orphan?: boolean | undefined;
}

export interface AdoptResult {
    devices: DevicesInput;
    report: SyncEntry[];
}

/** what an importer hands the generic sync */
export interface SyncSource<Raw> {
    kind: SourceInput['kind'];
    isRaw(value: unknown): value is Raw;
    /** regenerate the baseline from a stored `source.raw`; undefined when nothing maps */
    generate(raw: Raw): Generated | undefined;
    /** the kind of a configured device the discovery does not mention */
    kindOf(key: string, raw: Raw | undefined): 'device' | 'group';
}

/** a discovery as the generic sync reads it: the items and whether the source was seen for a kind */
export interface SyncDiscovery {
    items: Discovered[];
    /** the source published its description for this kind: devices missing from it are orphaned */
    seen(kind: 'device' | 'group'): boolean;
    /** the note for a device the discovery cannot judge because the source was not seen */
    notSeenNote(kind: 'device' | 'group'): string;
}

function withoutSource(device: DeviceInput): Omit<DeviceInput, 'source'> {
    const rest: Partial<DeviceInput> = structuredClone(device);
    delete rest.source;
    return rest as Omit<DeviceInput, 'source'>;
}

function validationNotes(device: DeviceInput): string[] {
    const parsed = DeviceSchema.safeParse(device);
    return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

export class Sync<Raw> {
    private readonly source: SyncSource<Raw>;

    constructor(source: SyncSource<Raw>) {
        this.source = source;
    }

    isOwn(device: DeviceInput): boolean {
        return device.source?.kind === this.source.kind;
    }

    orphaned(devices: DevicesInput): string[] {
        return Object.entries(devices)
            .filter(([, device]) => this.isOwn(device) && device.source?.orphaned === true)
            .map(([key]) => key);
    }

    /** the old baseline from `source.raw`, or undefined when it cannot be regenerated */
    private oldBaselineOf(current: DeviceInput): DeviceInput | undefined {
        const raw: unknown = current.source?.raw;
        return this.source.isRaw(raw) ? this.source.generate(raw)?.device : undefined;
    }

    /** the user's edits of a device against its baseline; empty when it is untouched or has no baseline */
    edits(device: DeviceInput): ReturnType<typeof editsOf> {
        const baseline = this.oldBaselineOf(device);
        return baseline === undefined ? [] : editsOf(baseline, device);
    }

    /** one config entry against its discovery */
    private syncOne(key: string, current: DeviceInput, item: Discovered): SyncEntry {
        const base: Omit<SyncEntry, 'status'> = {
            key,
            kind: item.kind,
            name: item.name,
            conflicts: [],
            edits: 0,
            unmapped: item.unmapped,
            notes: [],
            ...(item.area === undefined ? {} : {area: item.area}),
            ...(item.native === undefined ? {} : {native: item.native}),
        };
        const wasOrphaned = current.source?.orphaned === true;
        const newBaseline = item.baseline;
        if (newBaseline === undefined) {
            return {...base, status: 'unsupported', device: current, notes: [item.reason ?? 'cannot be adopted']};
        }
        const oldBaseline = this.oldBaselineOf(current);
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
        // a conflict means the baseline moved under an edit: reported as updated even when the edit kept its value
        const changed = !deepEqual(withoutSource(device), withoutSource(current)) || result.conflicts.length > 0;
        const status: SyncStatus = wasOrphaned ? 'restored' : changed ? 'updated' : 'unchanged';
        return {...base, status, device, conflicts: result.conflicts, edits: result.edits.length};
    }

    /** what adopting the discovery onto `devices` would do, entry by entry */
    diff(discovery: SyncDiscovery, devices: DevicesInput): SyncEntry[] {
        const entries: SyncEntry[] = [];
        const byKey = new Map(discovery.items.map((item) => [item.key, item]));
        for (const [key, current] of Object.entries(devices)) {
            if (!this.isOwn(current)) {
                continue;
            }
            const item = byKey.get(key);
            if (item !== undefined) {
                entries.push(this.syncOne(key, current, item));
                byKey.delete(key);
                continue;
            }
            const raw: unknown = current.source?.raw;
            const kind = this.source.kindOf(key, this.source.isRaw(raw) ? raw : undefined);
            const seen = discovery.seen(kind);
            const device = structuredClone(current);
            if (seen) {
                device.source = {...(device.source ?? {kind: this.source.kind}), orphaned: true};
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
                notes: seen ? [] : [discovery.notSeenNote(kind)],
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
                ...(item.area === undefined ? {} : {area: item.area}),
                ...(item.native === undefined ? {} : {native: item.native}),
            });
        }
        return entries;
    }

    /** the `devices` record after adopting: existing entries in place and order, new ones appended */
    adopt(devices: DevicesInput, discovery: SyncDiscovery, options: AdoptOptions = {}): AdoptResult {
        const report = this.diff(discovery, devices);
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
}
