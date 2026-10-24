/* Restart and update from the UI without a real npm run or a real exit: the root helper over a temporary
   directory with a fake installer, the updater with a stubbed registry, the routes with a stubbed restart. */

/* eslint-disable @typescript-eslint/no-explicit-any -- the answers are JSON */

import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {applyUpdate, type UpdateHost} from '../src/commands/update.ts';
import {parseConfig} from '../src/config/load.ts';
import {createLogger} from '../src/log.ts';
import {ConfigStore} from '../src/server/config-store.ts';
import {LogBuffer} from '../src/server/log-buffer.ts';
import {Server} from '../src/server/server.ts';
import {compareVersions, Updater} from '../src/server/update.ts';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-update-'));
});

afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
});

function fakeHost(code = 0): UpdateHost & {installed: string[]; restarts: number} {
    const host = {
        installed: [] as string[],
        restarts: 0,
        install: (version: string, log: (text: string) => void): Promise<number> => {
            host.installed.push(version);
            log(`added 1 package (${version})`);
            return Promise.resolve(code);
        },
        restart: () => {
            host.restarts++;
        },
    };
    return host;
}

const exists = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

describe('compareVersions', () => {
    it('orders x.y.z and pre-releases', () => {
        expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
        expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    });
});

describe('the root helper (--apply-update)', () => {
    it('installs the requested version, logs, restarts, and removes the request', async () => {
        await writeFile(join(dir, 'request'), '0.2.0\n');
        const host = fakeHost();
        expect(await applyUpdate(dir, host)).toBe(0);
        expect(host.installed).toEqual(['0.2.0']);
        expect(host.restarts).toBe(1);
        expect(await exists(join(dir, 'request'))).toBe(false);
        expect(await readFile(join(dir, 'update.log'), 'utf8')).toBe(
            'installing mqtt2matter@0.2.0\nadded 1 package (0.2.0)\ninstalled mqtt2matter@0.2.0; restarting\n',
        );
    });

    it('refuses anything but a version, and does not restart when npm fails', async () => {
        await writeFile(join(dir, 'request'), '0.2.0 && rm -rf /\n');
        const host = fakeHost();
        expect(await applyUpdate(dir, host)).toBe(1);
        expect(host.installed).toEqual([]);
        expect(await readFile(join(dir, 'update.log'), 'utf8')).toContain('refused');

        await writeFile(join(dir, 'request'), '0.3.0');
        const failing = fakeHost(1);
        expect(await applyUpdate(dir, failing)).toBe(1);
        expect(failing.restarts).toBe(0);
        expect(await readFile(join(dir, 'update.log'), 'utf8')).toContain('failed: npm exited with 1');
    });

    it('follows no link: neither a request nor a log planted as a symlink', async () => {
        const secret = join(dir, 'secret');
        await writeFile(secret, '0.9.9');
        await symlink(secret, join(dir, 'request'));
        const victim = join(dir, 'victim');
        await writeFile(victim, 'untouched');
        await symlink(victim, join(dir, 'update.log'));
        const host = fakeHost();
        expect(await applyUpdate(dir, host)).toBe(1);
        expect(host.installed).toEqual([]);
        expect(await readFile(victim, 'utf8')).toBe('untouched');
        expect(await readFile(join(dir, 'update.log'), 'utf8')).toContain('refused: no readable request');
    });
});

describe('the updater', () => {
    it('not published: says so, refuses an update; the registry is asked once per interval', async () => {
        let calls = 0;
        const updater = new Updater({
            current: '0.1.0',
            supervisor: 'systemd',
            updateDir: dir,
            fetchLatest: () => {
                calls++;
                return Promise.resolve(undefined);
            },
        });
        await updater.check();
        await updater.check();
        expect(calls).toBe(1);
        await updater.check(true);
        expect(calls).toBe(2);
        const status = await updater.status();
        expect(status).toMatchObject({current: '0.1.0', published: false, newer: false});
        expect(status.restart).toEqual({available: true});
        expect(status.update.available).toBe(true);
        expect(await updater.request('0.2.0')).toBe('mqtt2matter is not published on npm yet');
    });

    it('a newer latest: the request file for the path unit; nothing older or other', async () => {
        const updater = new Updater({
            current: '0.1.0',
            supervisor: 'systemd',
            updateDir: dir,
            fetchLatest: () => Promise.resolve('0.2.0'),
        });
        await updater.check();
        expect(updater.known).toEqual({latest: '0.2.0', newer: true});
        expect(await updater.request('0.1.5')).toContain('only the newer latest version 0.2.0');
        expect(await updater.request('x')).toBe('not a version');
        expect(await updater.request('0.2.0')).toBeUndefined();
        expect(await readFile(join(dir, 'request'), 'utf8')).toBe('0.2.0\n');
        expect((await updater.status()).update.requested).toBe('0.2.0');
    });

    it('a registry error is reported, not thrown', async () => {
        const updater = new Updater({current: '0.1.0', fetchLatest: () => Promise.reject(new Error('offline'))});
        await updater.check();
        expect((await updater.status()).error).toBe('offline');
    });

    it('outside systemd: neither restart nor update', async () => {
        const updater = new Updater({current: '0.1.0', fetchLatest: () => Promise.resolve('0.2.0')});
        await updater.check();
        const status = await updater.status();
        expect(status.restart.available).toBe(false);
        expect(status.restart.reason).toContain('not running as the systemd service');
        expect(status.update.available).toBe(false);
        expect(await updater.request('0.2.0')).toContain('installed without the systemd service');
    });
});

describe('the routes', () => {
    async function start(updater: Updater, onRestart: () => void): Promise<{base: string; close: () => Promise<void>}> {
        const raw = {storage: join(dir, 'data')};
        const config = parseConfig(raw);
        const logBuffer = new LogBuffer();
        const log = createLogger('error', logBuffer.sink);
        const server = new Server({
            app: new App(config, {log}),
            store: new ConfigStore({path: join(dir, 'c.json'), raw, config}),
            log,
            logBuffer,
            version: '0.1.0',
            host: '127.0.0.1',
            port: 0,
            uiDir: join(dir, 'no-ui'),
            updater,
            onRestart,
        });
        await server.listen();
        return {base: `http://127.0.0.1:${server.port}`, close: () => server.close()};
    }

    const call = async (
        base: string,
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{status: number; json: any}> => {
        const response = await fetch(`${base}${path}`, {
            method,
            ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
        });
        return {status: response.status, json: await response.json()};
    };

    it('check, request an update, restart — under systemd', async () => {
        const updateDir = join(dir, 'update');
        await mkdir(updateDir);
        let restarts = 0;
        const {base, close} = await start(
            new Updater({
                current: '0.1.0',
                supervisor: 'systemd',
                updateDir,
                fetchLatest: () => Promise.resolve('0.2.0'),
            }),
            () => restarts++,
        );
        try {
            const status = await call(base, 'GET', '/api/update?check=1');
            expect(status.json).toMatchObject({current: '0.1.0', latest: '0.2.0', newer: true, published: true});
            expect((await call(base, 'GET', '/api/status')).json.update).toEqual({latest: '0.2.0', newer: true});
            expect((await call(base, 'POST', '/api/update', {version: '0.1.0'})).status).toBe(409);
            expect((await call(base, 'POST', '/api/update', {version: '0.2.0'})).json).toEqual({requested: '0.2.0'});
            expect(await readFile(join(updateDir, 'request'), 'utf8')).toBe('0.2.0\n');
            expect((await call(base, 'POST', '/api/restart', {})).json).toEqual({restarting: true});
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(restarts).toBe(1);
        } finally {
            await close();
        }
    });

    it('without a supervisor the restart is refused and nothing exits', async () => {
        let restarts = 0;
        const {base, close} = await start(
            new Updater({current: '0.1.0', fetchLatest: () => Promise.resolve(undefined)}),
            () => restarts++,
        );
        try {
            const refused = await call(base, 'POST', '/api/restart', {});
            expect(refused.status).toBe(409);
            expect(refused.json.error).toContain('not running as the systemd service');
            expect((await call(base, 'GET', '/api/update')).json).toMatchObject({published: false, newer: false});
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(restarts).toBe(0);
        } finally {
            await close();
        }
    });
});
