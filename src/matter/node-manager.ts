/* The node manager: the process-wide matter.js environment (storage root, log level), n ≥ 1 bridges from
   `config.bridges` in configuration order, and the devices placed into them through the shard map. 1.0
   runs one bridge; nothing here assumes it. */

import {mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {Environment, Logger as MatterLogger, LogLevel as MatterLogLevel} from '@matter/main';

import type {Config} from '../config/schema.ts';
import type {Logger} from '../log.ts';
import type {DeviceConfig} from '../model/schema.ts';
import {Bridge, type BridgeInfo, type DeviceHandle} from './bridge.ts';
import {CommissioningStore} from './commissioning.ts';
import {ShardMap} from './shards.ts';

export interface NodeManagerOptions {
    config: Config;
    softwareVersion: string;
    log: Logger;
}

export const MATTER_LEVELS: Record<Config['log']['matter'], MatterLogLevel> = {
    debug: MatterLogLevel.DEBUG,
    info: MatterLogLevel.INFO,
    notice: MatterLogLevel.NOTICE,
    warn: MatterLogLevel.WARN,
    error: MatterLogLevel.ERROR,
    fatal: MatterLogLevel.FATAL,
};

let environmentPrepared = false;

/** matter.js reads the storage path from its default environment once per process */
export function prepareEnvironment(storagePath: string, matterLogLevel: Config['log']['matter']): void {
    MatterLogger.level = MATTER_LEVELS[matterLogLevel];
    if (environmentPrepared) {
        const current = Environment.default.vars.get('storage.path');
        if (current !== storagePath) {
            throw new Error(
                `matter.js storage is already ${String(current)}; it cannot change to ${storagePath} in this process`,
            );
        }
        return;
    }
    Environment.default.vars.set('storage.path', storagePath);
    // the application owns SIGINT and SIGTERM: matter.js' own handler would cancel the nodes behind the back of
    // the orderly stop, which then finds them closing, goes on and exits before their storage is closed
    Environment.default.vars.set('runtime.signals', false);
    environmentPrepared = true;
}

export class NodeManager {
    readonly storagePath: string;
    private readonly options: NodeManagerOptions;
    private readonly bridges = new Map<string, Bridge>();
    private readonly placement = new Map<string, string>();
    private shards: ShardMap | undefined;
    private readonly log: Logger;

    constructor(options: NodeManagerOptions) {
        this.options = options;
        this.storagePath = resolve(options.config.storage);
        this.log = options.log;
    }

    bridge(id: string): Bridge | undefined {
        return this.bridges.get(id);
    }

    allBridges(): Bridge[] {
        return [...this.bridges.values()];
    }

    /** the device's handle, wherever it lives */
    handle(deviceKey: string): DeviceHandle | undefined {
        const bridgeId = this.placement.get(deviceKey);
        return bridgeId === undefined ? undefined : this.bridges.get(bridgeId)?.handle(deviceKey);
    }

    /** every device handle, keyed by device key */
    handles(): Map<string, DeviceHandle> {
        const result = new Map<string, DeviceHandle>();
        for (const bridge of this.bridges.values()) {
            for (const handle of bridge.devices()) {
                result.set(handle.key, handle);
            }
        }
        return result;
    }

    /** create the bridges and place the enabled devices; nothing is online before `start()` */
    async prepare(): Promise<void> {
        const {config, softwareVersion} = this.options;
        await mkdir(this.storagePath, {recursive: true});
        prepareEnvironment(this.storagePath, config.log.matter);
        this.shards = await ShardMap.load(join(this.storagePath, 'shards.json'));
        const commissioning = await CommissioningStore.load(join(this.storagePath, 'commissioning.json'));
        let index = 0;
        for (const [id, bridgeConfig] of Object.entries(config.bridges)) {
            this.bridges.set(
                id,
                new Bridge({
                    id,
                    config: bridgeConfig,
                    vendorId: config.vendorId,
                    productId: (config.productId + index) & 0xffff,
                    softwareVersion,
                    commissioning: commissioning.resolve(id, {
                        passcode: bridgeConfig.passcode,
                        discriminator: bridgeConfig.discriminator,
                    }),
                    log: this.log.child(id),
                }),
            );
            index++;
        }
        await commissioning.save();
        for (const [key, device] of Object.entries(config.devices)) {
            await this.place(key, device);
        }
        await this.shards.save();
    }

    private async place(key: string, device: DeviceConfig): Promise<void> {
        if (this.shards === undefined) {
            throw new Error('prepare() first');
        }
        if (!device.enabled) {
            this.log.info(`${key} is disabled`);
            return;
        }
        const order = Object.entries(this.options.config.bridges).map(([id, b]) => ({id, maxDevices: b.maxDevices}));
        const {bridgeId, moved} = this.shards.assign(key, order, device.bridge);
        if (moved) {
            this.log.warn(
                `${key} moved to bridge ${bridgeId}: controllers see a new device and lose its rooms and automations`,
            );
        }
        const bridge = this.bridges.get(bridgeId);
        if (bridge === undefined) {
            // the map remembers a bridge that is no longer configured: keep the memory, use the first one
            const fallback = this.bridges.values().next().value;
            if (fallback === undefined) {
                throw new Error('no bridge configured');
            }
            this.log.warn(
                `${key} is assigned to bridge "${bridgeId}", which is not configured; using "${fallback.id}" without changing the assignment`,
            );
            this.placement.set(key, fallback.id);
            await fallback.addDevice(key, device);
            return;
        }
        this.placement.set(key, bridgeId);
        await bridge.addDevice(key, device);
    }

    /** add or replace a device while running: placed by the shard map, installed into its bridge at once */
    async addDevice(key: string, device: DeviceConfig): Promise<DeviceHandle | undefined> {
        if (this.shards === undefined) {
            throw new Error('prepare() first');
        }
        await this.removeDevice(key);
        await this.place(key, device);
        await this.shards.save();
        return this.handle(key);
    }

    /** take a device out of its bridge; the shard map keeps the assignment for a later return */
    async removeDevice(key: string): Promise<void> {
        const bridgeId = this.placement.get(key);
        this.placement.delete(key);
        if (bridgeId !== undefined) {
            await this.bridges.get(bridgeId)?.removeDevice(key);
        }
    }

    /** start the bridges one after the other */
    async start(): Promise<void> {
        if (this.shards === undefined) {
            await this.prepare();
        }
        for (const bridge of this.bridges.values()) {
            await bridge.start();
        }
    }

    async stop(): Promise<void> {
        for (const bridge of [...this.bridges.values()].reverse()) {
            await bridge.stop();
        }
    }

    info(): BridgeInfo[] {
        return this.allBridges().map((b) => b.info());
    }
}
