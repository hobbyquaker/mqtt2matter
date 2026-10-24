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
