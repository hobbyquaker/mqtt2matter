/* The application: the MQTT connection, the Matter node manager and the binding runtime between them.
   Start order: connect to the broker (so retained status is there when the endpoints come up), build the
   bridges and endpoints, wire the bindings (which subscribes the status topics), go online, log the
   pairing codes. */

import {createRequire} from 'node:module';

import type {Config} from './config/schema.ts';
import {BindingRuntime} from './engine/runtime.ts';
import {type Logger, silentLogger} from './log.ts';
import {NodeManager} from './matter/node-manager.ts';
import {MqttClient} from './mqtt/client.ts';

const pkg = createRequire(import.meta.url)('../package.json') as {version: string};

export const VERSION: string = pkg.version;

export interface AppOptions {
    log?: Logger;
    /** ms to wait for the first MQTT connection; default 30 s */
    mqttConnectTimeout?: number;
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
        );
        this.mqtt.on('message', (topic, payload) => {
            this.runtime.handleMessage(topic, payload).catch((error: unknown) => {
                this.log.error(`handling ${topic} failed`, error);
            });
        });
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        await this.mqtt.connect();
        await this.nodes.prepare();
        await this.nodes.start();
        const handles = this.nodes.handles();
        for (const [key, device] of Object.entries(this.config.devices)) {
            const handle = handles.get(key);
            if (handle === undefined) {
                continue;
            }
            const targets = new Map([[device.endpoints[0]?.id ?? 'main', handle]]);
            this.runtime.bind(key, device, targets);
        }
        this.runtime.onTopic((topic) => {
            this.mqtt.subscribe(topic).catch((error: unknown) => {
                this.log.error(`subscribing ${topic} failed`, error);
            });
        });
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

    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        await this.nodes.stop();
        await this.mqtt.close();
    }
}
