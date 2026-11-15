/* The MQTT connection: mqtt.js with reconnect, the subscriptions it re-establishes itself, a message
   event with the raw payload, and the topic cache fed with everything that arrives. A connection error never
   ends the process: mqtt.js keeps reconnecting, and the errors are logged with a backoff so a broker that is
   away for hours does not fill the log. */

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
    /** ms to wait for the first connection in `connect()`; default: wait until the broker is there */
    connectTimeout?: number;
}

/** the first connection error is logged at once, the next ones after 10 s, 20 s, 40 s … at most every 10 min */
export const ERROR_LOG_FIRST_DELAY_MS = 10_000;
export const ERROR_LOG_MAX_DELAY_MS = 600_000;

export interface PublishOptions {
    retain?: boolean;
    qos?: 0 | 1 | 2;
}

export interface MqttEvents {
    connect: [];
    close: [];
    message: [topic: string, payload: Buffer, retain: boolean];
}

export class MqttClient extends EventEmitter<MqttEvents> {
    readonly cache = new TopicCache();
    private readonly options: MqttOptions;
    private readonly log: Logger;
    private client: MqttJsClient | undefined;
    private readonly subscriptions = new Set<string>();
    /** connection errors since the last one logged */
    private suppressedErrors = 0;
    private nextErrorLog = 0;
    private errorLogDelay = ERROR_LOG_FIRST_DELAY_MS;
    private wasConnected = false;
    private abortConnect: ((error: Error) => void) | undefined;

    constructor(options: MqttOptions, log: Logger) {
        super();
        this.options = options;
        this.log = log;
    }

    get connected(): boolean {
        return this.client?.connected ?? false;
    }

    /**
     * Connect and resolve on the first CONNACK. Without `connectTimeout` it waits as long as the broker is away
     * (mqtt.js retries every `reconnectPeriod`); with one it rejects after that time, naming the last error.
     */
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
        let lastError: Error | undefined;
        client.on('connect', () => {
            const errors = this.suppressedErrors;
            this.resetErrorLog();
            this.wasConnected = true;
            this.log.info(
                `connected to ${this.options.url}${errors > 0 ? ` (${errors} more connection error(s) not logged)` : ''}`,
            );
            this.emit('connect');
        });
        client.on('close', () => {
            // mqtt.js closes after every failed attempt too; only losing a connection is worth a line
            if (this.wasConnected) {
                this.wasConnected = false;
                this.log.warn(`connection to ${this.options.url} closed, reconnecting`);
            }
            this.emit('close');
        });
        client.on('error', (error) => {
            lastError = error;
            this.logError(error);
        });
        client.on('message', (topic, payload, packet) => {
            this.cache.store(topic, payload, packet.retain);
            this.emit('message', topic, payload, packet.retain);
        });
        await new Promise<void>((resolve, reject) => {
            const timeoutMs = this.options.connectTimeout;
            const timeout =
                timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.abortConnect = undefined;
                          reject(
                              new Error(
                                  `no connection to ${this.options.url} within ${timeoutMs} ms` +
                                      (lastError === undefined ? '' : `: ${lastError.message}`),
                              ),
                          );
                      }, timeoutMs);
            this.abortConnect = (error) => {
                clearTimeout(timeout);
                reject(error);
            };
            const waiting = setTimeout(() => {
                if (!client.connected) {
                    this.log.warn(`waiting for the broker at ${this.options.url}`);
                }
            }, 2000);
            waiting.unref();
            client.once('connect', () => {
                clearTimeout(timeout);
                clearTimeout(waiting);
                this.abortConnect = undefined;
                resolve();
            });
        });
    }

    /** log a connection error now, or count it until the backoff has passed */
    private logError(error: Error): void {
        const now = Date.now();
        if (now < this.nextErrorLog) {
            this.suppressedErrors += 1;
            return;
        }
        const more = this.suppressedErrors;
        this.suppressedErrors = 0;
        this.nextErrorLog = now + this.errorLogDelay;
        this.log.error(
            `mqtt error: ${error.message}` +
                (more > 0 ? ` (and ${more} more since the last one logged)` : '') +
                `; retrying, the next error is logged in ${Math.round(this.errorLogDelay / 1000)} s at the earliest`,
        );
        this.errorLogDelay = Math.min(this.errorLogDelay * 2, ERROR_LOG_MAX_DELAY_MS);
    }

    private resetErrorLog(): void {
        this.suppressedErrors = 0;
        this.nextErrorLog = 0;
        this.errorLogDelay = ERROR_LOG_FIRST_DELAY_MS;
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
        this.abortConnect?.(new Error('closed before the broker was reached'));
        this.abortConnect = undefined;
        if (client !== undefined) {
            await client.endAsync();
        }
    }
}
