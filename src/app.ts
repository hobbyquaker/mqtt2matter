/* The application: the MQTT connection, the Matter node manager and the binding runtime between them.
   Start order: connect to the broker (so retained status is there when the endpoints come up), build the
   bridges and endpoints, wire the bindings (which subscribes the status topics), go online, log the
   pairing codes. */

import {createRequire} from 'node:module';

import type {Config} from './config/schema.ts';
import {BindingRuntime, type Codec} from './engine/runtime.ts';
import {type Logger, silentLogger} from './log.ts';
import type {DeviceHandle} from './matter/bridge.ts';
import {NodeManager} from './matter/node-manager.ts';
import type {DeviceConfig} from './model/schema.ts';
import {validateDevice, validateDevices} from './model/validate.ts';
import {MqttClient} from './mqtt/client.ts';

const pkg = createRequire(import.meta.url)('../package.json') as {version: string};

export const VERSION: string = pkg.version;

export interface AppOptions {
    log?: Logger;
    /** ms to wait for the first MQTT connection; default 30 s */
    mqttConnectTimeout?: number;
    /** the codec modules the config names, loaded by `loadCodecs` */
    codecs?: ReadonlyMap<string, Codec>;
}

export class App {
    readonly log: Logger;
    readonly mqtt: MqttClient;
    readonly nodes: NodeManager;
    readonly runtime: BindingRuntime;
    readonly config: Config;
    private started = false;

    constructor(config: Config, options: AppOptions = {}) {
        this.config = config;
        this.log = options.log ?? silentLogger;
        const mqttOptions = {
            url: config.mqtt.url,
            username: config.mqtt.username,
            password: config.mqtt.password,
            clientId: config.mqtt.clientId,
            ...(options.mqttConnectTimeout === undefined ? {} : {connectTimeout: options.mqttConnectTimeout}),
        };
        this.mqtt = new MqttClient(mqttOptions, this.log.child('mqtt'));
        this.nodes = new NodeManager({config, softwareVersion: VERSION, log: this.log.child('matter')});
        this.runtime = new BindingRuntime(
            {
                publish: async (topic, payload, {retain, qos}) => {
                    await this.mqtt.publish(topic, payload, {retain, qos});
                },
            },
            this.log.child('bindings'),
            {codecs: options.codecs ?? new Map()},
        );
        this.mqtt.on('message', (topic, payload) => {
            this.runtime.handleMessage(topic, payload).catch((error: unknown) => {
                this.log.error(`handling ${topic} failed`, error);
            });
        });
        this.mqtt.on('connect', () => {
            if (this.started) {
                // a reconnect: ask the devices that need asking for their state again
                this.runtime.publishGets().catch((error: unknown) => {
                    this.log.error('publishing the get requests failed', error);
                });
            }
        });
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        for (const [key, result] of validateDevices(this.config.devices)) {
            for (const issue of result.issues) {
                this.log[issue.level === 'error' ? 'error' : 'warn'](`${key} ${issue.path}: ${issue.message}`);
            }
            const device = this.config.devices[key];
            if (!result.ok && device?.enabled === true) {
                this.log.error(`${key}: not built, the configuration has errors`);
                device.enabled = false;
            }
        }
        await this.mqtt.connect();
        await this.nodes.prepare();
        await this.nodes.start();
        const handles = this.nodes.handles();
        for (const [key, device] of Object.entries(this.config.devices)) {
            const handle = handles.get(key);
            if (handle === undefined) {
                continue;
            }
            this.runtime.bind(key, device, handle.targets());
        }
        const subscriptions: Promise<void>[] = [];
        this.runtime.onTopic((topic) => {
            subscriptions.push(
                this.mqtt.subscribe(topic).catch((error: unknown) => {
                    this.log.error(`subscribing ${topic} failed`, error);
                }),
            );
        });
        // the status topics are subscribed before anything is asked to report
        await Promise.all(subscriptions);
        await this.runtime.publishGets();
        for (const info of this.nodes.info()) {
            const codes = info.pairingCodes;
            if (codes === undefined) {
                continue;
            }
            if (info.commissioned) {
                this.log.info(`bridge ${info.id}: commissioned, port ${info.port}`);
            } else {
                this.log.info(
                    `bridge ${info.id}: not commissioned — manual pairing code ${codes.manualPairingCode}, QR ${codes.qrPairingCode}`,
                );
            }
        }
    }

    get running(): boolean {
        return this.started;
    }

    /**
     * Add or replace a device while running: its old endpoint and bindings go, the new entry is validated,
     * built in its bridge and wired. A device with errors is kept in the configuration but not built.
     */
    async applyDevice(key: string, device: DeviceConfig): Promise<DeviceHandle | undefined> {
        this.runtime.unbind(key);
        await this.nodes.removeDevice(key);
        this.config.devices[key] = device;
        if (!this.started) {
            return undefined;
        }
        const result = validateDevice(device);
        for (const issue of result.issues) {
            this.log[issue.level === 'error' ? 'error' : 'warn'](`${key} ${issue.path}: ${issue.message}`);
        }
        if (!device.enabled) {
            return undefined;
        }
        if (!result.ok) {
            this.log.error(`${key}: not built, the configuration has errors`);
            return undefined;
        }
        const handle = await this.nodes.addDevice(key, device);
        if (handle !== undefined) {
            this.runtime.bind(key, device, handle.targets());
        }
        return handle;
    }

    /** remove a device while running */
    async removeDevice(key: string): Promise<void> {
        this.runtime.unbind(key);
        await this.nodes.removeDevice(key);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.config.devices[key];
    }

    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        await this.runtime.flush();
        this.runtime.close();
        await this.nodes.stop();
        await this.mqtt.close();
    }
}
