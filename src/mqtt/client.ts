/* The MQTT connection: mqtt.js with reconnect, the subscriptions it re-establishes itself, a message
   event with the raw payload, and the topic cache fed with everything that arrives. */

import {EventEmitter} from 'node:events';

import mqtt, {type IClientOptions, type MqttClient as MqttJsClient} from 'mqtt';

import type {Logger} from '../log.ts';
import {TopicCache} from './topic-cache.ts';

export interface MqttOptions {
    url: string;
    username?: string | undefined;
    password?: string | undefined;
    clientId?: string | undefined;
    /** ms between reconnects (mqtt.js default 1000) */
    reconnectPeriod?: number;
    /** ms to wait for the first connection in `connect()`; default 30 s */
    connectTimeout?: number;
}

export interface PublishOptions {
    retain?: boolean;
    qos?: 0 | 1 | 2;
}

export interface MqttEvents {
    connect: [];
    close: [];
    error: [Error];
    message: [topic: string, payload: Buffer, retain: boolean];
}

export class MqttClient extends EventEmitter<MqttEvents> {
    readonly cache = new TopicCache();
    private readonly options: MqttOptions;
    private readonly log: Logger;
    private client: MqttJsClient | undefined;
    private readonly subscriptions = new Set<string>();

    constructor(options: MqttOptions, log: Logger) {
        super();
        this.options = options;
        this.log = log;
    }

    get connected(): boolean {
        return this.client?.connected ?? false;
    }

    /** connect and resolve on the first CONNACK; rejects after `connectTimeout` or on a refused connection */
    async connect(): Promise<void> {
        if (this.client !== undefined) {
            return;
        }
        const clientOptions: IClientOptions = {
            clientId: this.options.clientId ?? `mqtt2matter_${Math.random().toString(16).slice(2, 10)}`,
            reconnectPeriod: this.options.reconnectPeriod ?? 1000,
            clean: true,
        };
        if (this.options.username !== undefined) {
            clientOptions.username = this.options.username;
        }
        if (this.options.password !== undefined) {
            clientOptions.password = this.options.password;
        }
        const client = mqtt.connect(this.options.url, clientOptions);
        this.client = client;
        client.on('connect', () => {
            this.log.info(`connected to ${this.options.url}`);
            this.emit('connect');
        });
        client.on('close', () => {
            this.log.warn(`connection to ${this.options.url} closed`);
            this.emit('close');
        });
        client.on('error', (error) => {
            this.log.error('mqtt error', error);
            this.emit('error', error);
        });
        client.on('message', (topic, payload, packet) => {
            this.cache.store(topic, payload, packet.retain);
            this.emit('message', topic, payload, packet.retain);
        });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(
                    new Error(
                        `no connection to ${this.options.url} within ${this.options.connectTimeout ?? 30_000} ms`,
                    ),
                );
            }, this.options.connectTimeout ?? 30_000);
            client.once('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
            client.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    /** subscribe once; mqtt.js re-subscribes after a reconnect (clean session, so we keep the list ourselves too) */
    async subscribe(topic: string): Promise<void> {
        if (this.subscriptions.has(topic)) {
            return;
        }
        this.subscriptions.add(topic);
        if (this.client === undefined) {
            return;
        }
        await this.client.subscribeAsync(topic);
        this.log.debug(`subscribed ${topic}`);
    }

    async publish(topic: string, payload: string | Buffer, options: PublishOptions = {}): Promise<void> {
        if (this.client === undefined) {
            throw new Error('not connected');
        }
        await this.client.publishAsync(topic, payload, {retain: options.retain ?? false, qos: options.qos ?? 0});
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        if (client !== undefined) {
            await client.endAsync();
        }
    }
}
