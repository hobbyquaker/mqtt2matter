/* The importers as the server runs them: each one subscribes its source topics through the server,
   takes the messages, and answers the adopt page with the importer's own report (`diff`) or applies an
   adoption (`adopt`) over the devices record as it stands in the file. The logic — baseline, the
   user's edits, conflicts, orphaning — is the importer's (docs/importers.md); the server only moves the
   results into the file and the running bridge. */

import {type AdoptOptions, type AdoptResult, ha, type SyncEntry, z2m} from '../importers/index.ts';
import type {Logger} from '../log.ts';
import type {DevicesInput} from '../model/schema.ts';
import type {TopicCache} from '../mqtt/topic-cache.ts';

export type {AdoptOptions, AdoptResult, SyncEntry};

/** the adopt options of every importer; `classes` only the Home Assistant importer takes */
export type ImporterAdoptOptions = ha.HaAdoptOptions;

export interface Importer {
    readonly kind: 'z2m' | 'ha-discovery';
    /** the topics to subscribe for the source */
    readonly topics: readonly string[];
    /** take a message; true when it was one of the source's (the view may have changed) */
    handle(topic: string, payload: Buffer): boolean;
    /** take what the cache already holds */
    load(cache: TopicCache): void;
    /** what adopting would do to `devices`; nothing is touched */
    diff(devices: DevicesInput): SyncEntry[];
    /** the devices record after adopting, with the report */
    adopt(devices: DevicesInput, options?: ImporterAdoptOptions): AdoptResult;
}

export class Z2mImporter implements Importer {
    readonly kind = 'z2m' as const;
    readonly source: z2m.Z2mSource;
    private readonly log: Logger | undefined;

    constructor(baseTopic = 'zigbee2mqtt', log?: Logger) {
        this.source = new z2m.Z2mSource(baseTopic);
        this.log = log;
    }

    get topics(): readonly string[] {
        return this.source.topics;
    }

    handle(topic: string, payload: Buffer): boolean {
        try {
            return this.source.handle(topic, payload) !== undefined;
        } catch (error) {
            this.log?.warn(`${topic}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    load(cache: TopicCache): void {
        try {
            this.source.load(cache);
        } catch (error) {
            this.log?.warn(
                `loading the retained bridge topics failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    diff(devices: DevicesInput): SyncEntry[] {
        return z2m.diff(this.source.discover(), devices);
    }

    adopt(devices: DevicesInput, options: AdoptOptions = {}): AdoptResult {
        return z2m.adopt(devices, this.source.discover(), options);
    }
}

export class HaImporter implements Importer {
    readonly kind = 'ha-discovery' as const;
    readonly source: ha.HaSource;
    private readonly log: Logger | undefined;

    constructor(prefix = 'homeassistant', log?: Logger) {
        this.source = new ha.HaSource(prefix);
        this.log = log;
    }

    get topics(): readonly string[] {
        return this.source.topics;
    }

    handle(topic: string, payload: Buffer): boolean {
        try {
            return this.source.handle(topic, payload) !== undefined;
        } catch (error) {
            this.log?.warn(`${topic}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    load(cache: TopicCache): void {
        const failed = this.source.load(cache);
        for (const topic of failed) {
            this.log?.warn(`${topic}: the retained discovery payload does not parse`);
        }
    }

    diff(devices: DevicesInput): SyncEntry[] {
        return ha.diff(this.source.discover(), devices);
    }

    adopt(devices: DevicesInput, options: ImporterAdoptOptions = {}): AdoptResult {
        return ha.adopt(devices, this.source.discover(), options);
    }
}
