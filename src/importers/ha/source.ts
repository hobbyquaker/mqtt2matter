/* The MQTT side of the Home Assistant discovery importer: every retained `<prefix>/…/config` kept as the
   entity it describes (both discovery forms), an empty payload removing it, and the discovery they yield.
   Feed it messages (`handle`) or the topic cache (`load`); the caller subscribes `<prefix>/#`. Parsing and
   keeping the configs is mqtt-ha-entities' `DiscoveryStore`; what is mqtt2matter's is `seen`, the cache
   and the discovery for the generator. */

import {DEFAULT_PREFIX, DiscoveryStore, parseDiscoveryTopic} from 'mqtt-ha-entities';

import type {TopicCache} from '../../mqtt/index.ts';
import {type Discovery, discover} from './sync.ts';
import type {DeviceInfo, EntityConfig, Origin} from './types.ts';

export {DEFAULT_PREFIX};

/** one discovered entity: a per-entity config, or one component of a device-based config */
export interface Entity {
    /** the discovery topic; for a device-based component `<topic>#<component key>` */
    id: string;
    /** the discovery topic */
    topic: string;
    /** `light`, `sensor`, `device_trigger`, … (the `platform` of a component) */
    component: string;
    /** the object id of the topic (or the component key), the entity's name within its device */
    objectId: string;
    nodeId?: string;
    config: EntityConfig;
}

export class HaSource {
    private readonly store: DiscoveryStore;
    /** a config message (or a removal) was seen: devices missing from the view are orphaned */
    seen = false;

    constructor(prefix: string = DEFAULT_PREFIX) {
        this.store = new DiscoveryStore({prefix});
    }

    get prefix(): string {
        return this.store.prefix;
    }

    /** entities by id */
    get entities(): ReadonlyMap<string, Entity> {
        return this.store.entities;
    }

    /** the topics to subscribe */
    get topics(): string[] {
        return this.store.subscriptions;
    }

    /**
     * take a message when its topic is a discovery config; `'entity'`, `'device'` or `'removed'`; throws a
     * `DiscoveryError` on a payload that is not a JSON object (what the topic announced before stays)
     */
    handle(topic: string, payload: string | Buffer): 'entity' | 'device' | 'removed' | undefined {
        if (parseDiscoveryTopic(this.prefix, topic) !== undefined) {
            this.seen = true;
        }
        return this.store.handle(topic, payload);
    }

    /** take what the cache holds under the prefix; a payload that does not parse is skipped */
    load(cache: TopicCache): string[] {
        const failed: string[] = [];
        for (const message of cache.match(`${this.prefix}/#`)) {
            try {
                this.handle(message.topic, message.payload);
            } catch {
                failed.push(message.topic);
            }
        }
        return failed;
    }

    discover(): Discovery {
        return discover({entities: [...this.entities.values()], prefix: this.prefix, seen: this.seen});
    }
}

export type {DeviceInfo, Origin};
