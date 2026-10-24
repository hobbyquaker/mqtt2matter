/* An in-process MQTT broker (aedes) on an ephemeral port: nothing fixed that could clash. */

import {createServer, type Server} from 'node:net';

import {Aedes} from 'aedes';

export interface Broker {
    url: string;
    port: number;
    close(): Promise<void>;
}

export async function startBroker(): Promise<Broker> {
    const aedes = await Aedes.createBroker();
    const server: Server = createServer(aedes.handle);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('no port');
    }
    return {
        url: `mqtt://127.0.0.1:${address.port}`,
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve) =>
                server.close(() => {
                    resolve();
                }),
            );
            await new Promise<void>((resolve) => {
                aedes.close(() => {
                    resolve();
                });
            });
        },
    };
}
