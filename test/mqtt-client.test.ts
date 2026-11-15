/* The broker connection survives the broker: a start waits for it, a lost connection and its errors never end
   the process, and the errors are logged with a backoff. Against the in-process aedes broker. */

import {createServer} from 'node:net';

import {afterEach, describe, expect, it} from 'vitest';

import {createLogger} from '../src/log.ts';
import {MqttClient} from '../src/mqtt/client.ts';
import {type Broker, startBroker} from './helpers/broker.ts';

/** a port nothing listens on: bound once, then released */
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve) =>
        server.close(() => {
            resolve();
        }),
    );
    if (address === null || typeof address === 'string') {
        throw new Error('no port');
    }
    return address.port;
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

let client: MqttClient | undefined;
let broker: Broker | undefined;

afterEach(async () => {
    await client?.close();
    client = undefined;
    await broker?.close();
    broker = undefined;
});

describe('MqttClient: a broker that is away', () => {
    it('waits at the start, logs the refused attempts with a backoff, and connects once the broker is there', async () => {
        const port = await freePort();
        const lines: string[] = [];
        client = new MqttClient(
            {url: `mqtt://127.0.0.1:${port}`, reconnectPeriod: 50},
            createLogger('debug', (line) => lines.push(line)),
        );
        let connected = false;
        const connecting = client.connect().then(() => {
            connected = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(connected).toBe(false);
        // about a dozen refused attempts by now: one error line, no close lines
        expect(lines.filter((line) => line.includes('ERROR'))).toEqual([
            expect.stringMatching(/mqtt error: .*ECONNREFUSED.*next error is logged in 10 s/),
        ]);
        expect(lines.filter((line) => line.includes('closed'))).toEqual([]);

        broker = await startBroker(port);
        await connecting;
        expect(client.connected).toBe(true);
        expect(lines.some((line) => /connected to .*\(\d+ more connection error\(s\) not logged\)/.test(line))).toBe(
            true,
        );
    });

    it('does not throw when the connection is lost, and reconnects', async () => {
        broker = await startBroker();
        const lines: string[] = [];
        client = new MqttClient(
            {url: broker.url, reconnectPeriod: 50},
            createLogger('debug', (line) => lines.push(line)),
        );
        await client.connect();
        let connects = 0;
        client.on('connect', () => {
            connects += 1;
        });
        // an error on the underlying mqtt.js client, as a keepalive timeout raises it: logged, never thrown
        (client as unknown as {client: {emit(event: string, error: Error): void}}).client.emit(
            'error',
            new Error('Keepalive timeout'),
        );
        expect(lines.filter((line) => line.includes('ERROR'))).toEqual([
            expect.stringContaining('mqtt error: Keepalive timeout'),
        ]);
        const port = broker.port;
        await broker.close();
        broker = undefined;
        await until(() => !client!.connected);
        expect(lines.filter((line) => line.includes('closed, reconnecting'))).toHaveLength(1);
        broker = await startBroker(port);
        await until(() => connects === 1);
        expect(client.connected).toBe(true);
    });

    it('rejects after connectTimeout when one is given, naming the last error', async () => {
        const port = await freePort();
        client = new MqttClient(
            {url: `mqtt://127.0.0.1:${port}`, reconnectPeriod: 50, connectTimeout: 300},
            createLogger('error', () => undefined),
        );
        await expect(client.connect()).rejects.toThrow(/within 300 ms: .*ECONNREFUSED/);
    });

    it('a close while waiting ends the wait', async () => {
        const port = await freePort();
        client = new MqttClient(
            {url: `mqtt://127.0.0.1:${port}`, reconnectPeriod: 50},
            createLogger('error', () => undefined),
        );
        const connecting = client.connect();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.close();
        client = undefined;
        await expect(connecting).rejects.toThrow(/closed before the broker was reached/);
    });
});
