/* An in-process MQTT broker (aedes) on an ephemeral port: nothing fixed that could clash. */

import {createServer, type Server, type Socket} from 'node:net';

import {Aedes} from 'aedes';

export interface Broker {
    url: string;
    port: number;
    close(): Promise<void>;
}

/** on `port`, or on an ephemeral one */
export async function startBroker(port = 0): Promise<Broker> {
    const aedes = await Aedes.createBroker();
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        aedes.handle(socket);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
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
            // the clients' connections end with the broker, as when a real one goes away
            for (const socket of sockets) {
                socket.destroy();
            }
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
