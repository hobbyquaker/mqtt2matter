/* The binding runtime: the bindings of every device, indexed by status topic; incoming payloads go through
   the payload engine to the endpoint target, controller commands come back through the engine to the
   publisher. The runtime knows neither mqtt.js nor matter.js — both are interfaces here — so it is testable
   with fakes and the layers stay where docs/architecture.md puts them. It also owns what spans bindings:
   availability (`all` / `any` / `latest` over topics) and `expire` → reachable, the `get` requests
   published at start and after a reconnect, and the coalescing of command payloads per topic. */

import {
    type AttributeRef,
    type CommandRef,
    attributeKey,
    commandKey,
    parseAttribute,
    parseCommand,
} from '../model/attribute.ts';
import {RELATED_STATUS} from '../model/catalog.ts';
import {
    type Availability,
    type AvailabilityTopic,
    type Binding,
    type CommandHalf,
    type DeviceConfig,
    type EndpointConfig,
    type StatusHalf,
    bindingTarget,
} from '../model/schema.ts';
import type {Logger} from '../log.ts';
import {
    type Decoded,
    type Decoder,
    type Encoder,
    type TargetShape,
    decodeStatus,
    encodeCommand,
    extract,
    isOptimistic,
    mergeJson,
    parsePath,
} from './payload.ts';
import {renderTemplate} from './template.ts';

/** a controller's command or write: publish, and answer whether the value is applied locally now */
export type CommandHandler = (value: unknown, fields: Record<string, unknown>) => Promise<boolean>;

/** the Matter side of one endpoint, as the runtime sees it */
export interface EndpointTarget {
    /** the attribute's shape for the engine, or undefined when the endpoint does not know it */
    shapeOf(ref: AttributeRef): TargetShape | undefined;
    /** write an attribute (a status arrived); composites go to the family */
    set(ref: AttributeRef, value: Decoded): Promise<void>;
    /** a family's event channel (`Switch`): the decoded value is the press kind or position */
    emitEvent(channel: string, value: Decoded): Promise<void>;
    /** register the handler for a controller's command or write on `key` (`OnOff.onOff`, `WindowCovering.stopMotion`) */
    onCommand(key: string, handler: CommandHandler | undefined): void;
    /** the bridged device's reachable flag; only the device's first endpoint carries it */
    setReachable(reachable: boolean): Promise<void>;
}

export interface Publisher {
    publish(topic: string, payload: string, options: {retain: boolean; qos: 0 | 1 | 2}): Promise<void>;
}

export interface Codec {
    decode?: Decoder;
    encode?: Encoder;
}

interface Subscription {
    deviceKey: string;
    endpointId: string;
    binding: Binding;
    half: StatusHalf;
    ref: AttributeRef | undefined;
    event: string | undefined;
    target: EndpointTarget;
    codec: Codec | undefined;
    where: string;
}

interface AvailabilityState {
    config: Availability;
    /** the last verdict per topic */
    verdicts: Map<string, boolean>;
    target: EndpointTarget;
}

interface DeviceState {
    key: string;
    main: EndpointTarget;
    availability: AvailabilityState | undefined;
    /** the expire timers per status topic */
    expired: Set<string>;
    timers: Map<string, NodeJS.Timeout>;
    reachable: boolean;
}

interface PendingPublish {
    json: unknown;
    options: {retain: boolean; qos: 0 | 1 | 2};
    timer: NodeJS.Timeout;
}

export interface RuntimeOptions {
    /** codec modules by `codec.module`, loaded by the application */
    codecs?: ReadonlyMap<string, Codec>;
}

export class BindingRuntime {
    private readonly byTopic = new Map<string, Subscription[]>();
    private readonly availabilityTopics = new Map<string, DeviceState[]>();
    private readonly topicsChanged = new Set<(topic: string) => void>();
    private readonly devices = new Map<string, DeviceState>();
    private readonly gets: {topic: string; payload: string}[] = [];
    private readonly pending = new Map<string, PendingPublish>();
    private readonly publisher: Publisher;
    private readonly log: Logger;
    private readonly codecs: ReadonlyMap<string, Codec>;

    constructor(publisher: Publisher, log: Logger, options: RuntimeOptions = {}) {
        this.publisher = publisher;
        this.log = log;
        this.codecs = options.codecs ?? new Map();
    }

    /** every topic the runtime listens to: status halves and availability */
    topics(): string[] {
        return [...new Set([...this.byTopic.keys(), ...this.availabilityTopics.keys()])];
    }

    /** called with each topic the runtime newly listens to (the MQTT layer subscribes) */
    onTopic(listener: (topic: string) => void): void {
        this.topicsChanged.add(listener);
        for (const topic of this.topics()) {
            listener(topic);
        }
    }

    /** the `get` requests: publish them at start and after every reconnect */
    async publishGets(): Promise<void> {
        for (const {topic, payload} of this.gets) {
            try {
                await this.publisher.publish(topic, payload, {retain: false, qos: 0});
            } catch (error) {
                this.log.warn(`get ${topic} failed: ${String(error)}`);
            }
        }
    }

    /** wire a device's bindings: status topics in, command handlers out, availability and expire */
    bind(deviceKey: string, device: DeviceConfig, targets: ReadonlyMap<string, EndpointTarget>): void {
        const main = targets.get(device.endpoints[0]?.id ?? 'main');
        if (main === undefined) {
            this.log.warn(`${deviceKey}: no Matter endpoint, the device is not wired`);
            return;
        }
        const state: DeviceState = {
            key: deviceKey,
            main,
            availability: undefined,
            expired: new Set(),
            timers: new Map(),
            reachable: true,
        };
        this.devices.set(deviceKey, state);
        if (device.availability !== undefined) {
            state.availability = {config: device.availability, verdicts: new Map(), target: main};
            for (const topic of device.availability.topics) {
                const list = this.availabilityTopics.get(topic.topic);
                if (list === undefined) {
                    this.availabilityTopics.set(topic.topic, [state]);
                    this.announce(topic.topic);
                } else {
                    list.push(state);
                }
            }
        }
        for (const endpoint of device.endpoints) {
            const target = targets.get(endpoint.id);
            if (target === undefined) {
                this.log.warn(`${deviceKey}/${endpoint.id}: no Matter endpoint, its bindings are not wired`);
                continue;
            }
            const statusKeys = new Set<string>();
            for (const binding of endpoint.bindings) {
                if (binding.status !== undefined) {
                    statusKeys.add(bindingTarget(binding).name);
                }
            }
            for (const binding of endpoint.bindings) {
                this.bindOne(deviceKey, endpoint, binding, target, statusKeys);
            }
        }
    }

    /** forget a device's bindings, timers and handlers */
    unbind(deviceKey: string): void {
        const state = this.devices.get(deviceKey);
        if (state === undefined) {
            return;
        }
        for (const timer of state.timers.values()) {
            clearTimeout(timer);
        }
        this.devices.delete(deviceKey);
        for (const [topic, list] of this.byTopic) {
            const kept = list.filter((s) => s.deviceKey !== deviceKey);
            if (kept.length === 0) {
                this.byTopic.delete(topic);
            } else {
                this.byTopic.set(topic, kept);
            }
        }
        for (const [topic, list] of this.availabilityTopics) {
            const kept = list.filter((s) => s.key !== deviceKey);
            if (kept.length === 0) {
                this.availabilityTopics.delete(topic);
            } else {
                this.availabilityTopics.set(topic, kept);
            }
        }
    }

    /** every pending coalesced publish goes out now */
    async flush(): Promise<void> {
        const topics = [...this.pending.keys()];
        await Promise.all(topics.map((topic) => this.flushTopic(topic)));
    }

    close(): void {
        for (const state of this.devices.values()) {
            for (const timer of state.timers.values()) {
                clearTimeout(timer);
            }
        }
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
        }
        this.pending.clear();
    }

    private bindOne(
        deviceKey: string,
        endpoint: EndpointConfig,
        binding: Binding,
        target: EndpointTarget,
        statusKeys: ReadonlySet<string>,
    ): void {
        const {kind, name} = bindingTarget(binding);
        const where = `${deviceKey}/${endpoint.id} ${name}`;
        let ref: AttributeRef | undefined;
        let command: CommandRef | undefined;
        try {
            if (kind === 'attribute') {
                ref = parseAttribute(name);
            } else if (kind === 'invoke') {
                command = parseCommand(name);
            }
        } catch (error) {
            this.log.error(`${where}: not wired`, error);
            return;
        }
        if (binding.status !== undefined) {
            const half = binding.status;
            const codec = half.codec === undefined ? undefined : this.codecs.get(half.codec.module);
            if (half.codec !== undefined && codec === undefined) {
                this.log.error(`${where}: codec ${half.codec.module} is not loaded; the status half is not wired`);
            } else if (kind === 'invoke') {
                this.log.warn(`${where}: a command binding has no status half; ignored`);
            } else {
                this.subscribe(half.topic, {
                    deviceKey,
                    endpointId: endpoint.id,
                    binding,
                    half,
                    ref,
                    event: kind === 'event' ? name : undefined,
                    target,
                    codec,
                    where,
                });
                if (half.get !== undefined) {
                    this.gets.push({topic: half.get.topic, payload: half.get.payload});
                }
            }
        }
        if (binding.command !== undefined) {
            const half = binding.command;
            const codec = half.codec === undefined ? undefined : this.codecs.get(half.codec.module);
            if (half.codec !== undefined && codec === undefined) {
                this.log.error(`${where}: codec ${half.codec.module} is not loaded; the command half is not wired`);
                return;
            }
            const key = ref !== undefined ? attributeKey(ref) : command !== undefined ? commandKey(command) : name;
            const shape = ref === undefined ? undefined : target.shapeOf(ref);
            // a command confirmed by another attribute's status (a cover's target by its position) is not optimistic
            const related = (RELATED_STATUS[key] ?? []).some((k) => statusKeys.has(k));
            const optimistic = half.optimistic ?? (!related && isOptimistic({status: binding.status, command: half}));
            target.onCommand(key, async (value, fields) => {
                let encoded;
                try {
                    encoded = encodeCommand(half, value, {target: shape, fields, codec: codec?.encode});
                } catch (error) {
                    this.log.error(`${where}: encoding ${JSON.stringify(value)} failed`, error);
                    return false;
                }
                this.log.debug(`${where} = ${JSON.stringify(value)} → ${half.topic} ${encoded.payload}`);
                await this.publish(half, encoded, endpoint.coalesce);
                return optimistic;
            });
        }
    }

    private subscribe(topic: string, subscription: Subscription): void {
        const list = this.byTopic.get(topic);
        if (list === undefined) {
            this.byTopic.set(topic, [subscription]);
            this.announce(topic);
        } else {
            list.push(subscription);
        }
    }

    private announce(topic: string): void {
        for (const listener of this.topicsChanged) {
            listener(topic);
        }
    }

    /** an MQTT message: every binding on that topic decodes it and sets its attribute */
    async handleMessage(topic: string, payload: Buffer): Promise<void> {
        const text = payload.toString('utf8');
        const availability = this.availabilityTopics.get(topic);
        if (availability !== undefined) {
            for (const state of availability) {
                await this.handleAvailability(state, topic, text);
            }
        }
        const subscriptions = this.byTopic.get(topic);
        if (subscriptions === undefined) {
            return;
        }
        for (const subscription of subscriptions) {
            const {half, ref, event, target, where, codec} = subscription;
            const shape = ref === undefined ? undefined : target.shapeOf(ref);
            const result = decodeStatus(half, text, shape, {topic, codec: codec?.decode});
            if (!result.ok) {
                this.log.warn(`${where}: ${topic} ignored, ${result.reason}`);
                continue;
            }
            this.log.debug(`${where} ← ${topic} ${text} = ${JSON.stringify(result.value)}`);
            try {
                if (event !== undefined) {
                    await target.emitEvent(event, result.value);
                } else if (ref !== undefined) {
                    await target.set(ref, result.value);
                }
            } catch (error) {
                this.log.error(`${where}: setting the attribute failed`, error);
            }
            if (half.expire !== undefined) {
                this.touchExpire(subscription, half.expire * 1000);
            }
        }
    }

    private touchExpire(subscription: Subscription, ms: number): void {
        const state = this.devices.get(subscription.deviceKey);
        if (state === undefined) {
            return;
        }
        const topic = subscription.half.topic;
        const existing = state.timers.get(topic);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        const report = (error: unknown): void => {
            this.log.error(`${state.key}: setting reachable failed`, error);
        };
        if (state.expired.delete(topic)) {
            this.updateReachable(state).catch(report);
        }
        const timer = setTimeout(() => {
            state.timers.delete(topic);
            state.expired.add(topic);
            this.log.info(`${state.key}: no message on ${topic} for ${ms / 1000} s, unreachable`);
            this.updateReachable(state).catch(report);
        }, ms);
        timer.unref();
        state.timers.set(topic, timer);
    }

    private async handleAvailability(state: DeviceState, topic: string, text: string): Promise<void> {
        const availability = state.availability;
        if (availability === undefined) {
            return;
        }
        for (const topicConfig of availability.config.topics) {
            if (topicConfig.topic !== topic) {
                continue;
            }
            const verdict = evaluateAvailability(topicConfig, text);
            if (verdict === undefined) {
                this.log.warn(`${state.key}: availability ${topic} ${text} is neither online nor offline`);
                continue;
            }
            if (availability.config.mode === 'latest') {
                availability.verdicts.clear();
            }
            availability.verdicts.set(topic, verdict);
        }
        await this.updateReachable(state);
    }

    private async updateReachable(state: DeviceState): Promise<void> {
        let reachable = true;
        const availability = state.availability;
        if (availability !== undefined && availability.verdicts.size > 0) {
            const verdicts = [...availability.verdicts.values()];
            switch (availability.config.mode) {
                case 'all':
                    reachable = verdicts.every(Boolean);
                    break;
                case 'any':
                    reachable = verdicts.some(Boolean);
                    break;
                default:
                    reachable = verdicts[verdicts.length - 1] ?? true;
            }
        }
        if (state.expired.size > 0) {
            reachable = false;
        }
        if (reachable === state.reachable) {
            return;
        }
        state.reachable = reachable;
        this.log.info(`${state.key}: ${reachable ? 'reachable' : 'unreachable'}`);
        try {
            await state.main.setReachable(reachable);
        } catch (error) {
            this.log.error(`${state.key}: setting reachable failed`, error);
        }
    }

    /** publish now, or merge into the topic's pending JSON when the endpoint coalesces */
    private async publish(
        half: CommandHalf,
        encoded: {payload: string; json: unknown},
        coalesce: number,
    ): Promise<void> {
        const options = {retain: half.retain, qos: half.qos};
        if (coalesce <= 0 || encoded.json === undefined || typeof encoded.json !== 'object' || encoded.json === null) {
            await this.flushTopic(half.topic);
            await this.publisher.publish(half.topic, encoded.payload, options);
            return;
        }
        // merged and sent when the window closes; the caller does not wait for it, so a family's several
        // writes in one command (level + on) land in one message
        const pending = this.pending.get(half.topic);
        if (pending !== undefined) {
            pending.json = mergeJson(pending.json, encoded.json);
            pending.options = options;
            return;
        }
        const entry: PendingPublish = {
            json: encoded.json,
            options,
            timer: setTimeout(() => {
                this.flushTopic(half.topic).catch((error: unknown) => {
                    this.log.error(`publishing ${half.topic} failed`, error);
                });
            }, coalesce),
        };
        this.pending.set(half.topic, entry);
    }

    private async flushTopic(topic: string): Promise<void> {
        const pending = this.pending.get(topic);
        if (pending === undefined) {
            return;
        }
        this.pending.delete(topic);
        clearTimeout(pending.timer);
        await this.publisher.publish(topic, JSON.stringify(pending.json), pending.options);
    }
}

/** online, offline, or undefined when the payload says neither */
export function evaluateAvailability(topic: AvailabilityTopic, text: string): boolean | undefined {
    let value: unknown = text;
    let json: unknown;
    if (topic.extract !== undefined) {
        try {
            json = JSON.parse(text);
        } catch {
            return undefined;
        }
        value = extract(json, parsePath(topic.extract));
    }
    if (topic.template !== undefined) {
        if (json === undefined) {
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
        }
        const rendered = renderTemplate(topic.template, {value, value_json: json, topic: topic.topic});
        if (!rendered.ok) {
            return undefined;
        }
        value = rendered.text;
    }
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (key === topic.online) {
        return true;
    }
    if (key === topic.offline) {
        return false;
    }
    return undefined;
}
