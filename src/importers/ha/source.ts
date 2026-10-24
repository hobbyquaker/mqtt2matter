/* The MQTT side of the Home Assistant discovery importer: every retained `<prefix>/…/config` kept as the
   entity it describes (both discovery forms), an empty payload removing it, and the discovery they yield.
   Feed it messages (`handle`) or the topic cache (`load`); the caller subscribes `<prefix>/#`. */

import type {TopicCache} from '../../mqtt/index.ts';
import {type Discovery, discover} from './sync.ts';
import {
    type DeviceInfo,
    type EntityConfig,
    expandDevicePayload,
    expandEntity,
    type Origin,
    parseDiscoveryTopic,
} from './types.ts';

export const DEFAULT_PREFIX = 'homeassistant';

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
    readonly prefix: string;
    /** entities by id */
    readonly entities = new Map<string, Entity>();
    /** the device-based configs by topic, with their component ids, so a new payload replaces all of them */
    private readonly deviceConfigs = new Map<string, string[]>();
    /** a config message (or a removal) was seen: devices missing from the view are orphaned */
    seen = false;

    constructor(prefix: string = DEFAULT_PREFIX) {
        this.prefix = prefix;
    }

    /** the topics to subscribe */
    get topics(): string[] {
        return [`${this.prefix}/#`];
    }

    /** take a message when its topic is a discovery config; `'entity'`, `'device'` or `'removed'`; throws on bad JSON */
    handle(topic: string, payload: string | Buffer): 'entity' | 'device' | 'removed' | undefined {
        const parsed = parseDiscoveryTopic(this.prefix, topic);
        if (parsed === undefined) {
            return undefined;
        }
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        this.seen = true;
        if (text.trim() === '') {
            this.remove(topic);
            return 'removed';
        }
        const json: unknown = JSON.parse(text);
        if (typeof json !== 'object' || json === null || Array.isArray(json)) {
            throw new Error(`${topic}: the discovery payload is not an object`);
        }
        const raw = json as Record<string, unknown>;
        if (parsed.component === 'device') {
            this.remove(topic);
            const {components} = expandDevicePayload(raw);
            const ids: string[] = [];
            for (const [key, config] of Object.entries(components)) {
                if (typeof config.platform !== 'string' || config.platform === '') {
                    continue;
                }
                const id = `${topic}#${key}`;
                ids.push(id);
                this.entities.set(id, {
                    id,
                    topic,
                    component: config.platform,
                    objectId: key,
                    ...(parsed.nodeId === undefined ? {} : {nodeId: parsed.nodeId}),
                    config,
                });
            }
            this.deviceConfigs.set(topic, ids);
            return 'device';
        }
        this.entities.set(topic, {
            id: topic,
            topic,
            component: parsed.component,
            objectId: parsed.objectId,
            ...(parsed.nodeId === undefined ? {} : {nodeId: parsed.nodeId}),
            config: expandEntity(raw),
        });
        return 'entity';
    }

    private remove(topic: string): void {
        this.entities.delete(topic);
        for (const id of this.deviceConfigs.get(topic) ?? []) {
            this.entities.delete(id);
        }
        this.deviceConfigs.delete(topic);
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
