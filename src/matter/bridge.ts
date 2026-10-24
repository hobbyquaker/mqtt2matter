/* One Matter bridge: a ServerNode with an aggregator, the bridged devices under it, and a handle per
   device the runtime talks to. Several bridges live in one process (the node manager owns them); each
   has its own id — and therefore its own storage directory, fabrics and endpoint numbers — port, passcode
   and discriminator. The mDNS service is process-wide and shared. */

import {Endpoint, ServerNode, VendorId} from '@matter/main';
import {AggregatorEndpoint} from '@matter/main/endpoints/aggregator';

import type {BridgeConfig} from '../config/schema.ts';
import type {AttributeTarget} from '../engine/runtime.ts';
import {setOnOffHandler} from '../families/on-off.ts';
import type {Logger} from '../log.ts';
import type {AttributeRef} from '../model/attribute.ts';
import {attributeKey} from '../model/attribute.ts';
import type {DeviceConfig, Scalar} from '../model/schema.ts';
import {endpointTypeFor} from './device-types.ts';
import {deviceEndpointId, label32, randomDiscriminator, randomPasscode, uniqueId} from './ids.ts';

export interface BridgeOptions {
    id: string;
    config: BridgeConfig;
    vendorId: number;
    productId: number;
    softwareVersion: string;
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
    devices: {key: string; endpointId: string; number: number | undefined}[];
}

/** the Matter side of one device, as the runtime uses it; phase 0: one endpoint per device, no children */
export class DeviceHandle implements AttributeTarget {
    readonly key: string;
    readonly device: DeviceConfig;
    readonly endpoint: Endpoint;
    private readonly log: Logger;

    constructor(key: string, device: DeviceConfig, endpoint: Endpoint, log: Logger) {
        this.key = key;
        this.device = device;
        this.endpoint = endpoint;
        this.log = log;
    }

    get number(): number | undefined {
        return this.endpoint.maybeNumber;
    }

    /** the endpoint's state (matter.js' immutable view), keyed by behavior id */
    get state(): Record<string, Record<string, unknown>> {
        return this.endpoint.state;
    }

    async set(ref: AttributeRef, value: Scalar): Promise<void> {
        if (!this.endpoint.lifecycle.isReady) {
            throw new Error(`endpoint ${this.key} is not ready`);
        }
        if (!(ref.behaviorId in this.endpoint.state)) {
            throw new Error(`endpoint ${this.key} has no cluster ${ref.cluster}`);
        }
        await this.endpoint.set({[ref.behaviorId]: {[ref.attribute]: value}});
    }

    onCommand(ref: AttributeRef, handler: (value: Scalar) => Promise<boolean>): void {
        if (attributeKey(ref) === 'OnOff.onOff') {
            setOnOffHandler(this.endpoint, handler);
            return;
        }
        this.log.warn(
            `${this.key}: commands for ${attributeKey(ref)} are not supported yet; the binding's command half is ignored`,
        );
    }

    async setReachable(reachable: boolean): Promise<void> {
        await this.endpoint.set({bridgedDeviceBasicInformation: {reachable}} as never);
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
        setOnOffHandler(handle.endpoint, undefined);
        await handle.endpoint.close();
    }

    async start(): Promise<void> {
        if (this.node !== undefined) {
            return;
        }
        const {config, vendorId, productId, softwareVersion} = this.options;
        const name = label32(config.name, `mqtt2matter ${this.id}`);
        const node = await ServerNode.create({
            id: this.id,
            network: {port: config.port},
            commissioning: {
                passcode: config.passcode ?? randomPasscode(),
                discriminator: config.discriminator ?? randomDiscriminator(),
            },
            productDescription: {
                name,
                deviceType: AggregatorEndpoint.deviceType,
            },
            basicInformation: {
                vendorName: 'mqtt2matter',
                vendorId: VendorId(vendorId),
                nodeLabel: name,
                productName: 'mqtt2matter',
                productLabel: name,
                productId,
                serialNumber: label32(`mqtt2matter-${this.id}`, this.id),
                uniqueId: uniqueId('bridge', this.id),
                softwareVersionString: softwareVersion,
                hardwareVersionString: '1',
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
        await node.start();
        this.log.info(`bridge ${this.id} online on port ${config.port}, ${this.handles.size} device(s)`);
    }

    /** stop the node; its storage stays, so a later start keeps fabrics and endpoint numbers */
    async stop(): Promise<void> {
        const node = this.node;
        this.node = undefined;
        this.aggregator = undefined;
        for (const handle of this.handles.values()) {
            setOnOffHandler(handle.endpoint, undefined);
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
            devices: this.devices().map((h) => ({key: h.key, endpointId: h.endpoint.id, number: h.number})),
        };
    }

    private async install(key: string, device: DeviceConfig): Promise<DeviceHandle | undefined> {
        if (this.aggregator === undefined) {
            throw new Error('bridge not started');
        }
        const [main, ...children] = device.endpoints;
        if (main === undefined) {
            return undefined;
        }
        if (children.length > 0) {
            this.log.warn(
                `${key}: child endpoints (${children.map((c) => c.id).join(', ')}) are not supported yet, only "${main.id}" is built`,
            );
        }
        let type;
        try {
            type = endpointTypeFor(main.deviceTypes);
        } catch (error) {
            this.log.error(`${key}: not built`, error);
            return undefined;
        }
        const endpoint = new Endpoint(type, {
            id: deviceEndpointId(key),
            bridgedDeviceBasicInformation: {
                nodeLabel: label32(device.name, key),
                vendorName: label32(device.vendor, 'mqtt2matter'),
                productName: label32(device.model, main.deviceTypes[0] ?? 'device'),
                productLabel: label32(device.model, main.deviceTypes[0] ?? 'device'),
                serialNumber: label32(device.serial, key),
                uniqueId: uniqueId(this.id, key),
                softwareVersionString: this.options.softwareVersion,
                hardwareVersionString: '1',
                reachable: true,
            },
        });
        try {
            await this.aggregator.add(endpoint);
        } catch (error) {
            this.log.error(`${key}: the endpoint failed to initialise`, error);
            return undefined;
        }
        const handle = new DeviceHandle(key, device, endpoint, this.log);
        this.handles.set(key, handle);
        this.log.debug(`${key} = endpoint ${endpoint.number} (${main.deviceTypes.join(', ')})`);
        return handle;
    }
}
