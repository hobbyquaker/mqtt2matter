/* The process stops cleanly: SIGTERM, SIGINT and the restart from the UI close the bridges and their storage
   before the process exits — matter.js' storage lock is gone and it never has to remove an orphaned one at
   exit (which it does, with a warning, when the storage was still open: writes in flight would be lost). The
   real entry point runs as a child process, from the sources. */

import {type ChildProcess, spawn} from 'node:child_process';
import {access, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {type Broker, startBroker} from './helpers/broker.ts';
import {freeUdpPort, waitFor} from './helpers/util.ts';

let broker: Broker;
let storage: string;

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-shutdown-'));
});

afterAll(async () => {
    await broker.close();
    await rm(storage, {recursive: true, force: true});
});

async function freeTcpPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
    if (address === null || typeof address === 'string') {
        throw new Error('no port');
    }
    return address.port;
}

interface Run {
    child: ChildProcess;
    output: () => string;
    exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
}

async function start(server: {enabled: boolean; port?: number}): Promise<Run> {
    const file = join(storage, 'mqtt2matter.json');
    await writeFile(
        file,
        JSON.stringify({
            mqtt: {url: broker.url},
            storage,
            log: {level: 'info', matter: 'warn'},
            server: {...server, host: '127.0.0.1'},
            bridges: {default: {port: await freeUdpPort()}},
            devices: {plug: {name: 'Plug', endpoints: [{deviceTypes: ['OnOffPlugInUnit']}]}},
        }),
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, MQTT2MATTER_SUPERVISOR: 'systemd', NODE_NO_WARNINGS: '1'},
    });
    let text = '';
    child.stdout.on('data', (chunk) => (text += String(chunk)));
    child.stderr.on('data', (chunk) => (text += String(chunk)));
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
        child.on('exit', (code, signal) => {
            resolve({code, signal});
        });
    });
    await waitFor(() => text.includes('pairing code') || child.exitCode !== null, 30_000, 'the bridge online');
    expect(text).toContain('pairing code');
    return {child, output: () => text, exited};
}

async function expectClosedStorage(run: Run): Promise<void> {
    expect(run.output()).toContain('stopping');
    expect(run.output()).not.toMatch(/not closed before process exit|orphaned lock/);
    expect(run.output()).not.toContain('stop failed');
    const files = await readdir(join(storage, 'default'));
    expect(files).not.toContain('matter.lock');
    await expect(access(join(storage, 'default', 'matter.pid'))).rejects.toThrow();
}

describe('the process stops with its storage closed', () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        it(`on ${signal}`, async () => {
            const run = await start({enabled: false});
            run.child.kill(signal);
            expect(await run.exited).toEqual({code: 0, signal: null});
            await expectClosedStorage(run);
        }, 60_000);
    }

    it('on a restart from the UI, with the restart exit code', async () => {
        const port = await freeTcpPort();
        const run = await start({enabled: true, port});
        const response = await fetch(`http://127.0.0.1:${port}/api/restart`, {method: 'POST'});
        expect(response.status).toBe(200);
        expect(await run.exited).toEqual({code: 75, signal: null});
        await expectClosedStorage(run);
    }, 60_000);
});
