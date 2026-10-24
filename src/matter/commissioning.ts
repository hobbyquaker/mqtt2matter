/* Each bridge's passcode and discriminator: generated once, persisted next to matter.js' storage and reused at
   every start, so the pairing code a user noted down (or the QR code printed from it) stays valid across
   restarts and updates until the bridge is commissioned. matter.js keeps no commissioning values of its own.
   Values in the configuration win and are not written here. */

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {randomDiscriminator, randomPasscode} from './ids.ts';

export interface CommissioningValues {
    passcode: number;
    discriminator: number;
}

function isValues(value: unknown): value is CommissioningValues {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const {passcode, discriminator} = value as Record<string, unknown>;
    return (
        Number.isInteger(passcode) &&
        (passcode as number) >= 1 &&
        (passcode as number) <= 99999998 &&
        Number.isInteger(discriminator) &&
        (discriminator as number) >= 0 &&
        (discriminator as number) <= 4095
    );
}

export class CommissioningStore {
    private readonly file: string;
    private readonly values: Map<string, CommissioningValues>;
    private dirty = false;

    constructor(file: string, entries: Record<string, CommissioningValues> = {}) {
        this.file = file;
        this.values = new Map(Object.entries(entries));
    }

    static async load(file: string): Promise<CommissioningStore> {
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return new CommissioningStore(file);
            }
            throw error;
        }
        try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('not an object');
            }
            const entries: Record<string, CommissioningValues> = {};
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (!isValues(value)) {
                    throw new Error(`"${id}" has no valid passcode and discriminator`);
                }
                entries[id] = {passcode: value.passcode, discriminator: value.discriminator};
            }
            return new CommissioningStore(file, entries);
        } catch (error) {
            throw new Error(`${file} is unreadable: ${(error as Error).message}`, {cause: error});
        }
    }

    /**
     * The bridge's values: the configured ones where set, the others as remembered, generated (and remembered)
     * the first time a bridge has none.
     */
    resolve(
        bridgeId: string,
        configured: {passcode?: number | undefined; discriminator?: number | undefined},
    ): CommissioningValues {
        if (configured.passcode !== undefined && configured.discriminator !== undefined) {
            return {passcode: configured.passcode, discriminator: configured.discriminator};
        }
        let stored = this.values.get(bridgeId);
        if (stored === undefined) {
            stored = {passcode: randomPasscode(), discriminator: randomDiscriminator()};
            this.values.set(bridgeId, stored);
            this.dirty = true;
        }
        return {
            passcode: configured.passcode ?? stored.passcode,
            discriminator: configured.discriminator ?? stored.discriminator,
        };
    }

    /** persist when something was generated; atomic through a temp file */
    async save(): Promise<void> {
        if (!this.dirty) {
            return;
        }
        await mkdir(dirname(this.file), {recursive: true});
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.values), null, 2)}\n`, {mode: 0o600});
        await rename(tmp, this.file);
        this.dirty = false;
    }
}
