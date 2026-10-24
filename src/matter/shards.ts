/* The shard map: which bridge a device lives in. Written once when a device is first seen, persisted
   next to matter.js' storage, never rebalanced — a device that moved between bridges would lose its
   rooms and automations in every controller. With one bridge (1.0) every device lands in it; the map
   exists from day one so the multi-bridge split (1.1) moves nothing. */

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export interface ShardBridge {
    id: string;
    /** 0 = unlimited */
    maxDevices: number;
}

export class ShardMap {
    private readonly file: string;
    private readonly map: Map<string, string>;
    private dirty = false;

    constructor(file: string, entries: Record<string, string> = {}) {
        this.file = file;
        this.map = new Map(Object.entries(entries));
    }

    static async load(file: string): Promise<ShardMap> {
        try {
            const text = await readFile(file, 'utf8');
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('not an object');
            }
            const entries: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value !== 'string') {
                    throw new Error(`"${key}" is not a bridge id`);
                }
                entries[key] = value;
            }
            return new ShardMap(file, entries);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return new ShardMap(file);
            }
            throw new Error(`shard map ${file} is unreadable: ${(error as Error).message}`, {cause: error});
        }
    }

    get(deviceKey: string): string | undefined {
        return this.map.get(deviceKey);
    }

    /** devices currently assigned to a bridge */
    count(bridgeId: string): number {
        let n = 0;
        for (const id of this.map.values()) {
            if (id === bridgeId) {
                n++;
            }
        }
        return n;
    }

    /**
     * The bridge for a device: the one configured on the device (an explicit move, recorded), else the
     * remembered one, else the first bridge in order with room. `bridges` is in configuration order.
     */
    assign(deviceKey: string, bridges: readonly ShardBridge[], explicit?: string): {bridgeId: string; moved: boolean} {
        const known = this.map.get(deviceKey);
        if (explicit !== undefined) {
            if (!bridges.some((b) => b.id === explicit)) {
                throw new Error(`device "${deviceKey}" names bridge "${explicit}", which is not configured`);
            }
            if (known !== explicit) {
                this.map.set(deviceKey, explicit);
                this.dirty = true;
            }
            return {bridgeId: explicit, moved: known !== undefined && known !== explicit};
        }
        if (known !== undefined) {
            return {bridgeId: known, moved: false};
        }
        const target =
            bridges.find((b) => b.maxDevices === 0 || this.count(b.id) < b.maxDevices) ?? bridges[bridges.length - 1];
        if (target === undefined) {
            throw new Error('no bridge configured');
        }
        this.map.set(deviceKey, target.id);
        this.dirty = true;
        return {bridgeId: target.id, moved: false};
    }

    /** persist when something changed; atomic through a temp file */
    async save(): Promise<void> {
        if (!this.dirty) {
            return;
        }
        await mkdir(dirname(this.file), {recursive: true});
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.map), null, 2)}\n`);
        await rename(tmp, this.file);
        this.dirty = false;
    }

    toJSON(): Record<string, string> {
        return Object.fromEntries(this.map);
    }
}
