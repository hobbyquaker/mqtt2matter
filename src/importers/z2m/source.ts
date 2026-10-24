/* The MQTT side of the Zigbee2MQTT importer: the two retained bridge topics, parsed and kept, and the
   discovery they yield. Feed it messages (`handle`) or the topic cache (`load`); the caller subscribes. */

import type {TopicCache} from '../../mqtt/index.ts';
import {DEFAULT_BASE_TOPIC} from './generate.ts';
import {type Discovery, discover} from './sync.ts';
import {type BridgeDevice, type BridgeGroup, parseBridgeDevices, parseBridgeGroups} from './types.ts';

export class Z2mSource {
    readonly baseTopic: string;
    readonly devicesTopic: string;
    readonly groupsTopic: string;
    devices: BridgeDevice[] | undefined;
    groups: BridgeGroup[] | undefined;

    constructor(baseTopic: string = DEFAULT_BASE_TOPIC) {
        this.baseTopic = baseTopic;
        this.devicesTopic = `${baseTopic}/bridge/devices`;
        this.groupsTopic = `${baseTopic}/bridge/groups`;
    }

    /** the topics to subscribe */
    get topics(): string[] {
        return [this.devicesTopic, this.groupsTopic];
    }

    /** take a message when its topic is one of ours; throws when the payload is not what zigbee2mqtt publishes */
    handle(topic: string, payload: string | Buffer): 'devices' | 'groups' | undefined {
        if (topic === this.devicesTopic) {
            this.devices = parseBridgeDevices(payload);
            return 'devices';
        }
        if (topic === this.groupsTopic) {
            this.groups = parseBridgeGroups(payload);
            return 'groups';
        }
        return undefined;
    }

    /** take what the cache holds of the two topics */
    load(cache: TopicCache): void {
        for (const topic of this.topics) {
            const message = cache.get(topic);
            if (message !== undefined) {
                this.handle(topic, message.payload);
            }
        }
    }

    discover(): Discovery {
        return discover({devices: this.devices, groups: this.groups, baseTopic: this.baseTopic});
    }
}
