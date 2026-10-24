/* The event stream: one WebSocket per browser tab, every event to every tab. The events are the
   ones docs/api.md lists; the hub knows nothing about where they come from. A client may ask to
   mute the MQTT events (a tab that is not on the live view does not need a busy broker's traffic). */

import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';

import {WebSocket, WebSocketServer} from 'ws';

import type {Logger} from '../log.ts';
import {toJson} from './http.ts';

export type ServerEvent =
    | {type: 'hello'; version: string}
    | {type: 'mqtt'; topic: string; payload: string; retain: boolean; ts: number}
    | {type: 'attribute'; key: string; endpoint: string; cluster: string; attribute: string; value: unknown}
    | {type: 'log'; entry: {id: number; ts: string; level: string; scope: string; message: string}}
    | {type: 'devices'}
    | {type: 'bridges'}
    | {type: 'discovered'}
    | {type: 'status'; mqtt: boolean};

interface Client {
    socket: WebSocket;
    mqtt: boolean;
}

export class EventHub {
    private readonly server = new WebSocketServer({noServer: true});
    private readonly clients = new Set<Client>();
    private readonly log: Logger;
    private readonly hello: () => ServerEvent;

    constructor(log: Logger, hello: () => ServerEvent) {
        this.log = log;
        this.hello = hello;
    }

    get size(): number {
        return this.clients.size;
    }

    /** take over an HTTP upgrade for `/api/events` */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        this.server.handleUpgrade(request, socket, head, (ws) => {
            const client: Client = {socket: ws, mqtt: true};
            this.clients.add(client);
            ws.on('message', (data) => {
                try {
                    const text = Array.isArray(data)
                        ? Buffer.concat(data).toString('utf8')
                        : data instanceof ArrayBuffer
                          ? Buffer.from(data).toString('utf8')
                          : data.toString('utf8');
                    const message = JSON.parse(text) as {type?: string; mqtt?: boolean};
                    if (message.type === 'subscribe' && typeof message.mqtt === 'boolean') {
                        client.mqtt = message.mqtt;
                    }
                } catch {
                    // a client that talks nonsense is ignored
                }
            });
            ws.on('close', () => {
                this.clients.delete(client);
            });
            ws.on('error', (error) => {
                this.log.debug(`event client: ${error.message}`);
                this.clients.delete(client);
            });
            ws.send(toJson(this.hello()));
        });
    }

    broadcast(event: ServerEvent): void {
        if (this.clients.size === 0) {
            return;
        }
        const text = toJson(event);
        for (const client of this.clients) {
            if (event.type === 'mqtt' && !client.mqtt) {
                continue;
            }
            if (client.socket.readyState === WebSocket.OPEN) {
                client.socket.send(text);
            }
        }
    }

    close(): void {
        for (const client of this.clients) {
            client.socket.close();
        }
        this.clients.clear();
        this.server.close();
    }
}
