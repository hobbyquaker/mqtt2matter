/* The event stream (`/api/events`): one WebSocket for the tab, reconnecting; the pages subscribe to
   the event types they care about, the shell shows whether the stream and the broker are up. */

import type {LogEntry} from './api.ts';

export type ServerEvent =
    | {type: 'hello'; version: string}
    | {type: 'mqtt'; topic: string; payload: string; retain: boolean; ts: number}
    | {type: 'attribute'; key: string; endpoint: string; cluster: string; attribute: string; value: unknown}
    | {type: 'log'; entry: LogEntry}
    | {type: 'devices'}
    | {type: 'bridges'}
    | {type: 'discovered'}
    | {type: 'status'; mqtt: boolean};

type Listener = (event: ServerEvent) => void;

class Events {
    connected = $state(false);
    mqttConnected = $state<boolean | undefined>(undefined);
    version = $state('');
    private socket: WebSocket | undefined;
    private readonly listeners = new Set<Listener>();
    private mqttWanted = 0;
    private retry: ReturnType<typeof setTimeout> | undefined;

    start(): void {
        if (this.socket !== undefined || typeof WebSocket === 'undefined') {
            return;
        }
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.onopen = () => {
            this.connected = true;
            this.sendSubscription();
        };
        socket.onmessage = (message) => {
            let event: ServerEvent;
            try {
                event = JSON.parse(String(message.data)) as ServerEvent;
            } catch {
                return;
            }
            if (event.type === 'hello') {
                this.version = event.version;
            } else if (event.type === 'status') {
                this.mqttConnected = event.mqtt;
            }
            for (const listener of this.listeners) {
                listener(event);
            }
        };
        socket.onclose = () => {
            this.connected = false;
            this.socket = undefined;
            this.retry = setTimeout(() => {
                this.start();
            }, 2000);
        };
        socket.onerror = () => {
            socket.close();
        };
    }

    stop(): void {
        if (this.retry !== undefined) {
            clearTimeout(this.retry);
        }
        this.socket?.close();
        this.socket = undefined;
    }

    /** subscribe; returns the unsubscribe */
    on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** a page that shows MQTT traffic asks for it while it is mounted */
    wantMqtt(): () => void {
        this.mqttWanted++;
        this.sendSubscription();
        return () => {
            this.mqttWanted--;
            this.sendSubscription();
        };
    }

    private sendSubscription(): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({type: 'subscribe', mqtt: this.mqttWanted > 0}));
        }
    }
}

export const events = new Events();
