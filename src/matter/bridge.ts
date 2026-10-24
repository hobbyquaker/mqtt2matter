/* One Matter bridge: a ServerNode with an aggregator, the bridged devices under it, and a handle per
   device endpoint the runtime talks to. Several bridges live in one process (the node manager owns them);
   each has its own id — and therefore its own storage directory, fabrics and endpoint numbers — port,
   passcode and discriminator. The mDNS service is process-wide and shared. A device's first endpoint is
   the bridged node (with BridgedDeviceBasicInformation), the others are its parts with ids
   `<key>~<endpoint id>`. */

import {Endpoint, ServerNode, VendorId} from '@matter/main';
import {AggregatorEndpoint} from '@matter/main/endpoints/aggregator';
import {DeviceTypeConformanceService} from '@matter/node';
import type {DeviceTypeViolation} from '@matter/main/model';

import type {BridgeConfig} from '../config/schema.ts';
import type {CommandHandler, EndpointTarget} from '../engine/runtime.ts';
import type {Decoded, TargetShape} from '../engine/payload.ts';
import {type FamilyContext, familyFor, forgetContext, registerContext} from '../families/index.ts';
import type {Logger} from '../log.ts';
import type {AttributeRef} from '../model/attribute.ts';
import {COMPOSITE_ATTRIBUTES, cluster as clusterInfo} from '../model/catalog.ts';
import {type DeviceConfig, type EndpointConfig, mappingTarget} from '../model/schema.ts';
import type {CommissioningValues} from './commissioning.ts';
import {type BuiltEndpoint, buildEndpoint} from './device-types.ts';
import {
    BRIDGE_PRODUCT_LABEL,
    bridgedInformation,
    childEndpointId,
    deviceEndpointId,
    HARDWARE_VERSION,
    label32,
    softwareVersionNumber,
    uniqueId,
    VENDOR_NAME,
} from './ids.ts';

/** the messages of an aggregate error's causes, matter.js style (`errors`, `cause`), flattened */
export function nestedErrors(error: unknown, depth = 0): string[] {
    if (depth > 4 || typeof error !== 'object' || error === null) {
        return [];
    }
    const result: string[] = [];
    const e = error as {errors?: unknown; cause?: unknown; message?: string};
    for (const child of Array.isArray(e.errors) ? e.errors : []) {
        const message = (child as {message?: string}).message;
        if (message !== undefined) {
            result.push(message);
        }
        result.push(...nestedErrors(child, depth + 1));
    }
    if (e.cause !== undefined) {
        const message = (e.cause as {message?: string}).message;
        if (message !== undefined) {
            result.push(message);
        }
        result.push(...nestedErrors(e.cause, depth + 1));
    }
    return result;
}

export interface BridgeOptions {
    id: string;
    config: BridgeConfig;
    vendorId: number;
    productId: number;
    softwareVersion: string;
    /** passcode and discriminator: configured, or generated once and persisted (`CommissioningStore`) */
    commissioning: CommissioningValues;
    log: Logger;
}

export interface PairingCodes {
    manualPairingCode: string;
    qrPairingCode: string;
}

export interface BridgeInfo {
    id: string;
    port: number;
    online: boolean;
    commissioned: boolean;
    pairingCodes: PairingCodes | undefined;
    devices: {key: string; endpointId: string; number: number | undefined; violations: number}[];
}

/** the Matter side of one endpoint of a device, as the runtime uses it */
export class EndpointHandle implements EndpointTarget {
    readonly key: string;
    readonly config: EndpointConfig;
    readonly endpoint: Endpoint;
    readonly built: BuiltEndpoint;
    readonly context: FamilyContext;
    /** the conformance violations matter.js reported for this endpoint */
    violations: DeviceTypeViolation[] = [];
    private readonly log: Logger;
    private readonly writeObservers: {attribute: string; off: () => void}[] = [];

    constructor(key: string, config: EndpointConfig, endpoint: Endpoint, built: BuiltEndpoint, log: Logger) {
        this.key = key;
        this.config = config;
        this.endpoint = endpoint;
        this.built = built;
        this.log = log;
        const statuses = new Set<string>();
        for (const mapping of config.mappings) {
            if (mapping.status !== undefined) {
                statuses.add(mappingTarget(mapping).name);
            }
        }
        this.context = {
            endpoint,
            options: config.options,
            features: built.features,
            commands: new Map(),
            statuses,
            log,
            scratch: new Map(),
        };
        registerContext(this.context);
        for (const [cluster, behaviorId] of built.clusters) {
            for (const attribute of familyFor(cluster)?.writes ?? []) {
                this.observe(cluster, attribute, behaviorId);
            }
        }
    }

    get number(): number | undefined {
        return this.endpoint.maybeNumber;
    }

    /** the endpoint's state (matter.js' immutable view), keyed by behavior id */
    get state(): Record<string, Record<string, unknown>> {
        return this.endpoint.state;
    }

    shapeOf(ref: AttributeRef): TargetShape | undefined {
        const key = `${ref.cluster}.${ref.attribute}`;
        if (key in COMPOSITE_ATTRIBUTES) {
            return {metatype: 'any'};
        }
        const info = clusterInfo(ref.cluster)?.attributes.get(ref.attribute);
        if (info === undefined) {
            return undefined;
        }
        return {
            metatype: info.metatype,
            nullable: info.nullable,
            enumMembers: info.enumMembers,
            bitFields: info.bitFields,
        };
    }

    async set(ref: AttributeRef, value: Decoded): Promise<void> {
        if (!this.endpoint.lifecycle.isReady) {
            throw new Error(`endpoint ${this.key} is not ready`);
        }
        const behaviorId = this.built.clusters.get(ref.cluster);
        if (behaviorId === undefined) {
            throw new Error(`endpoint ${this.key} has no cluster ${ref.cluster}`);
        }
        const family = familyFor(ref.cluster);
        if (family?.status !== undefined) {
            const result = await family.status(this.context, ref.attribute, value);
            if (result === true) {
                return;
            }
            if (result !== false) {
                await this.endpoint.set({[behaviorId]: result});
                return;
            }
        }
        if (`${ref.cluster}.${ref.attribute}` in COMPOSITE_ATTRIBUTES) {
            throw new Error(`${ref.cluster}.${ref.attribute} is a composite the family did not handle`);
        }
        await this.endpoint.set({[behaviorId]: {[ref.attribute]: value}});
    }

    async emitEvent(channel: string, value: Decoded): Promise<void> {
        const family = familyFor(channel);
        if (family?.event === undefined) {
            throw new Error(`${channel} has no event channel`);
        }
        await family.event(this.context, value);
    }

    onCommand(key: string, handler: CommandHandler | undefined): void {
        if (handler === undefined) {
            this.context.commands.delete(key);
            return;
        }
        this.context.commands.set(key, handler);
        const [cluster, attribute] = key.split('.') as [string, string | undefined];
        const behaviorId = this.built.clusters.get(cluster);
        if (attribute !== undefined && behaviorId !== undefined) {
            this.observe(cluster, attribute, behaviorId);
        }
    }

    /**
     * A writable attribute: controllers write it (matter.js applies the write), so a command half is routed
     * from the attribute's change with an online context, and the family keeps the cluster consistent.
     * Observed once per attribute.
     */
    private observe(cluster: string, attribute: string, behaviorId: string): void {
        const key = `${cluster}.${attribute}`;
        if (this.writeObservers.some((o) => o.attribute === key)) {
            return;
        }
        const info = clusterInfo(cluster)?.attributes.get(attribute);
        if (info?.writable !== true) {
            return;
        }
        const events = (this.endpoint.events as Record<string, Record<string, unknown> | undefined>)[behaviorId];
        const observable = events?.[`${attribute}$Changed`] as
            | {
                  on(observer: (value: unknown, old: unknown, context?: {offline?: boolean}) => void): void;
                  off(observer: unknown): void;
              }
            | undefined;
        if (observable === undefined) {
            return;
        }
        const family = familyFor(cluster);
        const observer = (value: unknown, _old: unknown, context?: {offline?: boolean}): void => {
            if (context?.offline === true) {
                return;
            }
            const fields: Record<string, unknown> = {};
            const shape = this.shapeOf({cluster, attribute, behaviorId});
            if (typeof value === 'number' && shape?.enumMembers !== undefined) {
                for (const [name, id] of shape.enumMembers) {
                    if (id === value) {
                        fields.name = name;
                    }
                }
            }
            const handler = this.context.commands.get(key);
            (handler === undefined ? Promise.resolve(true) : handler(value, fields))
                .then(async () => {
                    await family?.write?.(this.context, attribute, value);
                })
                .catch((error: unknown) => {
                    this.log.error(`${this.key} ${key}: routing the write failed`, error);
                });
        };
        observable.on(observer);
        this.writeObservers.push({
            attribute: key,
            off: () => {
                observable.off(observer);
            },
        });
    }

    async setReachable(reachable: boolean): Promise<void> {
        if (!('bridgedDeviceBasicInformation' in this.endpoint.state)) {
            return;
        }
        await this.endpoint.set({bridgedDeviceBasicInformation: {reachable}} as never);
    }

    close(): void {
        for (const {off} of this.writeObservers) {
            off();
        }
        this.writeObservers.length = 0;
        forgetContext(this.endpoint);
    }
}

/** one device: its endpoints by id; the first is the bridged node */
export class DeviceHandle {
    readonly key: string;
    readonly device: DeviceConfig;
    readonly endpoints: ReadonlyMap<string, EndpointHandle>;

    constructor(key: string, device: DeviceConfig, endpoints: ReadonlyMap<string, EndpointHandle>) {
        this.key = key;
        this.device = device;
        this.endpoints = endpoints;
    }

    get main(): EndpointHandle {
        const first = this.endpoints.values().next().value;
        if (first === undefined) {
            throw new Error(`device ${this.key} has no endpoint`);
        }
        return first;
    }

    get endpoint(): Endpoint {
        return this.main.endpoint;
    }

    get number(): number | undefined {
        return this.main.number;
    }

    get state(): Record<string, Record<string, unknown>> {
        return this.main.state;
    }

    /** the runtime's targets, keyed by the model's endpoint id */
    targets(): Map<string, EndpointTarget> {
        return new Map(this.endpoints);
    }

    violations(): {endpointId: string; violation: DeviceTypeViolation}[] {
        const result: {endpointId: string; violation: DeviceTypeViolation}[] = [];
        for (const [id, handle] of this.endpoints) {
            for (const violation of handle.violations) {
                result.push({endpointId: id, violation});
            }
        }
        return result;
    }
}

export class Bridge {
    readonly id: string;
    private readonly options: BridgeOptions;
    private readonly log: Logger;
    private node: ServerNode | undefined;
    private aggregator: Endpoint | undefined;
    private readonly handles = new Map<string, DeviceHandle>();
    private readonly pending = new Map<string, DeviceConfig>();

    constructor(options: BridgeOptions) {
        this.options = options;
        this.id = options.id;
        this.log = options.log;
    }

    get online(): boolean {
        return this.node?.lifecycle.isOnline ?? false;
    }

    get commissioned(): boolean {
        return this.node?.state.commissioning.commissioned ?? false;
    }

    get pairingCodes(): PairingCodes | undefined {
        if (this.node === undefined) {
            return undefined;
        }
        const {manualPairingCode, qrPairingCode} = this.node.state.commissioning.pairingCodes;
        return {manualPairingCode, qrPairingCode};
    }

    get port(): number {
        return this.options.config.port;
    }

    get serverNode(): ServerNode | undefined {
        return this.node;
    }

    devices(): DeviceHandle[] {
        return [...this.handles.values()];
    }

    handle(key: string): DeviceHandle | undefined {
        return this.handles.get(key);
    }

    /** register a device; installed when the bridge starts, or right away if it runs already */
    async addDevice(key: string, device: DeviceConfig): Promise<DeviceHandle | undefined> {
        if (this.aggregator === undefined) {
            this.pending.set(key, device);
            return undefined;
        }
        return await this.install(key, device);
    }

    async removeDevice(key: string): Promise<void> {
        this.pending.delete(key);
        const handle = this.handles.get(key);
        if (handle === undefined) {
            return;
        }
        this.handles.delete(key);
        for (const endpoint of handle.endpoints.values()) {
            endpoint.close();
        }
        await handle.endpoint.close();
    }

    /** create the node and the endpoints without going online (the dry run uses this) */
    async build(): Promise<void> {
        if (this.node !== undefined) {
            return;
        }
        const {config, vendorId, productId, softwareVersion} = this.options;
        const name = label32(config.name, `mqtt2matter ${this.id}`);
        const node = await ServerNode.create({
            id: this.id,
            network: {port: config.port},
            commissioning: {
                passcode: this.options.commissioning.passcode,
                discriminator: this.options.commissioning.discriminator,
            },
            productDescription: {
                name,
                deviceType: AggregatorEndpoint.deviceType,
            },
            basicInformation: {
                vendorName: VENDOR_NAME,
                vendorId: VendorId(vendorId),
                nodeLabel: name,
                productName: VENDOR_NAME,
                productLabel: BRIDGE_PRODUCT_LABEL,
                productId,
                serialNumber: label32(`mqtt2matter-${this.id}`, this.id),
                uniqueId: uniqueId('bridge', this.id),
                softwareVersion: softwareVersionNumber(softwareVersion),
                softwareVersionString: softwareVersion.slice(0, 64),
                hardwareVersion: HARDWARE_VERSION,
                hardwareVersionString: String(HARDWARE_VERSION),
            },
        });
        this.node = node;
        const aggregator = new Endpoint(AggregatorEndpoint, {id: 'aggregator'});
        await node.add(aggregator);
        this.aggregator = aggregator;
        for (const [key, device] of this.pending) {
            await this.install(key, device);
        }
        this.pending.clear();
    }

    async start(): Promise<void> {
        await this.build();
        const node = this.node;
        if (node === undefined || node.lifecycle.isOnline) {
            return;
        }
        await node.start();
        this.log.info(`bridge ${this.id} online on port ${this.options.config.port}, ${this.handles.size} device(s)`);
    }

    /** stop the node; its storage stays, so a later start keeps fabrics and endpoint numbers */
    async stop(): Promise<void> {
        const node = this.node;
        this.node = undefined;
        this.aggregator = undefined;
        for (const handle of this.handles.values()) {
            for (const endpoint of handle.endpoints.values()) {
                endpoint.close();
            }
        }
        this.handles.clear();
        if (node !== undefined) {
            await node.close();
        }
    }

    info(): BridgeInfo {
        return {
            id: this.id,
            port: this.port,
            online: this.online,
            commissioned: this.commissioned,
            pairingCodes: this.pairingCodes,
            devices: this.devices().map((h) => ({
                key: h.key,
                endpointId: h.endpoint.id,
                number: h.number,
                violations: h.violations().length,
            })),
        };
    }

    private async install(key: string, device: DeviceConfig): Promise<DeviceHandle | undefined> {
        if (this.aggregator === undefined || this.node === undefined) {
            throw new Error('bridge not started');
        }
        const [main, ...children] = device.endpoints;
        if (main === undefined) {
            return undefined;
        }
        type Built = {config: EndpointConfig; built: BuiltEndpoint; endpoint: Endpoint};
        const built = new Map<string, Built>();
        const children_ = new Map<string, Built>();
        let mainEntry: Built;
        try {
            const parts: Endpoint[] = [];
            for (const child of children) {
                const childBuilt = buildEndpoint(child);
                const endpoint = new Endpoint(childBuilt.type, {
                    id: childEndpointId(key, child.id),
                    ...childBuilt.defaults,
                });
                parts.push(endpoint);
                children_.set(child.id, {config: child, built: childBuilt, endpoint});
            }
            const mainBuilt = buildEndpoint(main, main.options, {bridged: true});
            const primaryType = main.deviceTypes[0] ?? 'device';
            const endpoint = new Endpoint(mainBuilt.type, {
                id: deviceEndpointId(key),
                parts,
                ...mainBuilt.defaults,
                bridgedDeviceBasicInformation: bridgedInformation(
                    this.id,
                    key,
                    device,
                    primaryType,
                    this.options.softwareVersion,
                ),
            });
            mainEntry = {config: main, built: mainBuilt, endpoint};
        } catch (error) {
            this.log.error(`${key}: not built`, error);
            return undefined;
        }
        // the main entry first: the runtime's reachable flag lives there
        built.set(main.id, mainEntry);
        for (const [id, entry] of children_) {
            built.set(id, entry);
        }
        try {
            await this.aggregator.add(mainEntry.endpoint);
        } catch (error) {
            this.log.error(`${key}: the endpoint failed to initialise`, error);
            for (const detail of nestedErrors(error)) {
                this.log.error(`${key}: ${detail}`);
            }
            return undefined;
        }
        const handles = new Map<string, EndpointHandle>();
        for (const [id, {config, built: b, endpoint}] of built) {
            const handle = new EndpointHandle(key, config, endpoint, b, this.log.child(`${key}/${id}`));
            handles.set(id, handle);
            handle.violations = this.violationsOf(endpoint);
            for (const violation of handle.violations) {
                this.log.warn(
                    `${key}/${id}: ${violation.deviceType} ${violation.kind} ${violation.requirement}: ${violation.detail}`,
                );
            }
        }
        const handle = new DeviceHandle(key, device, handles);
        this.handles.set(key, handle);
        this.log.debug(
            `${key} = endpoint ${handle.endpoint.number} (${main.deviceTypes.join(', ')})${children.length > 0 ? ` + ${children.length} child endpoint(s)` : ''}`,
        );
        return handle;
    }

    private violationsOf(endpoint: Endpoint): DeviceTypeViolation[] {
        const node = this.node;
        if (node === undefined) {
            return [];
        }
        try {
            const service = node.env.get(DeviceTypeConformanceService);
            const verdict = service.validate(endpoint);
            return [...verdict.values()].flat();
        } catch (error) {
            this.log.debug(`conformance check unavailable: ${String(error)}`);
            return [];
        }
    }
}
