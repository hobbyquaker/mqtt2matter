import {createSocket} from 'node:dgram';

/** poll until `check` is true; fails after `timeout` ms */
export async function waitFor(
    check: () => boolean | Promise<boolean>,
    timeout = 10_000,
    what = 'condition',
): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await check()) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(`timeout waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * retry `assertions` until all of them pass; after `timeout` ms the last failure is thrown as it is. For the
 * attributes one MQTT message sets: the mappings are applied one after the other, so waiting for the first of
 * them says nothing about the others yet.
 */
export async function settled(assertions: () => void, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            assertions();
            return;
        } catch (error) {
            if (Date.now() > deadline) {
                throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** a UDP port nothing listens on right now (matter.js binds its operational port without reuse) */
export async function freeUdpPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const socket = createSocket({type: 'udp6', ipv6Only: false});
        socket.once('error', reject);
        socket.bind(0, () => {
            const {port} = socket.address();
            socket.close(() => {
                resolve(port);
            });
        });
    });
}
