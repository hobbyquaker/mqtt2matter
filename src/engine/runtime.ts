/* The binding runtime: the bindings of every device, indexed by status topic; incoming payloads go through
   the payload engine to the attribute target, controller writes come back through the engine to the
   publisher. The runtime knows neither mqtt.js nor matter.js — both are interfaces here — so it is testable
   with fakes and the layers stay where docs/architecture.md puts them. */

import {parseAttribute, type AttributeRef, attributeKey} from '../model/attribute.ts';
import type {Binding, DeviceConfig, Scalar} from '../model/schema.ts';
import type {Logger} from '../log.ts';
import {decodeStatus, encodeCommand, isOptimistic} from './payload.ts';

/** the Matter side of one device endpoint, as the runtime sees it */
export interface AttributeTarget {
    /** write an attribute (a status arrived) */
    set(ref: AttributeRef, value: Scalar): Promise<void>;
    /**
     * a controller changed the attribute (command or write): `handler` publishes and answers whether the
     * change is to be applied locally now (optimistic) or left for the device's status report
     */
    onCommand(ref: AttributeRef, handler: (value: Scalar) => Promise<boolean>): void;
}

export interface Publisher {
    publish(topic: string, payload: string, options: {retain: boolean; qos: 0 | 1 | 2}): Promise<void>;
}

interface Subscription {
    deviceKey: string;
    endpointId: string;
    binding: Binding;
    ref: AttributeRef;
    target: AttributeTarget;
}

export class BindingRuntime {
    private readonly byTopic = new Map<string, Subscription[]>();
    private readonly topicsChanged = new Set<(topic: string) => void>();
    private readonly publisher: Publisher;
    private readonly log: Logger;

    constructor(publisher: Publisher, log: Logger) {
        this.publisher = publisher;
        this.log = log;
    }

    /** every status topic a binding listens to */
    topics(): string[] {
        return [...this.byTopic.keys()];
    }

    /** called with each topic the runtime newly listens to (the MQTT layer subscribes) */
    onTopic(listener: (topic: string) => void): void {
        this.topicsChanged.add(listener);
        for (const topic of this.byTopic.keys()) {
            listener(topic);
        }
    }

    /** wire a device's bindings: status topics in, command handlers out */
    bind(deviceKey: string, device: DeviceConfig, targets: ReadonlyMap<string, AttributeTarget>): void {
        for (const endpoint of device.endpoints) {
            const target = targets.get(endpoint.id);
            if (target === undefined) {
                this.log.warn(`${deviceKey}/${endpoint.id}: no Matter endpoint, its bindings are not wired`);
                continue;
            }
            for (const binding of endpoint.bindings) {
                const ref = parseAttribute(binding.attribute);
                const subscription: Subscription = {deviceKey, endpointId: endpoint.id, binding, ref, target};
                if (binding.status !== undefined) {
                    this.subscribe(binding.status.topic, subscription);
                }
                if (binding.command !== undefined) {
                    const command = binding.command;
                    target.onCommand(ref, async (value) => {
                        const payload = encodeCommand(command, value);
                        this.log.debug(
                            `${deviceKey}/${endpoint.id} ${attributeKey(ref)} = ${String(value)} → ${command.topic} ${payload}`,
                        );
                        await this.publisher.publish(command.topic, payload, {
                            retain: command.retain,
                            qos: command.qos,
                        });
                        return isOptimistic({status: binding.status, command});
                    });
                }
            }
        }
    }

    private subscribe(topic: string, subscription: Subscription): void {
        const list = this.byTopic.get(topic);
        if (list === undefined) {
            this.byTopic.set(topic, [subscription]);
            for (const listener of this.topicsChanged) {
                listener(topic);
            }
        } else {
            list.push(subscription);
        }
    }

    /** an MQTT message: every binding on that topic decodes it and sets its attribute */
    async handleMessage(topic: string, payload: Buffer): Promise<void> {
        const subscriptions = this.byTopic.get(topic);
        if (subscriptions === undefined) {
            return;
        }
        for (const {deviceKey, endpointId, binding, ref, target} of subscriptions) {
            if (binding.status === undefined) {
                continue;
            }
            const result = decodeStatus(binding.status, payload);
            const where = `${deviceKey}/${endpointId} ${attributeKey(ref)}`;
            if (!result.ok) {
                this.log.warn(`${where}: ${topic} ignored, ${result.reason}`);
                continue;
            }
            this.log.debug(`${where} ← ${topic} ${payload.toString('utf8')} = ${String(result.value)}`);
            try {
                await target.set(ref, result.value);
            } catch (error) {
                this.log.error(`${where}: setting the attribute failed`, error);
            }
        }
    }
}
