/* Who may use the API and the event stream, per mode: none (open), password (a login, an HttpOnly session
   cookie, throttled failures, logout, expiry) and proxy (a header set by a reverse proxy); the access settings
   set from the UI. The server runs on an ephemeral port; the application is not started (no broker, no node):
   the gate is in front of every route. */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- the answers are JSON */

import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';
import {WebSocket} from 'ws';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {createLogger} from '../src/log.ts';
import {Auth, hashPassword, isPasswordHash, verifyPassword} from '../src/server/auth.ts';
import {ConfigStore} from '../src/server/config-store.ts';
import {LogBuffer} from '../src/server/log-buffer.ts';
import {Server} from '../src/server/server.ts';

interface Running {
    base: string;
    dir: string;
    path: string;
    close(): Promise<void>;
}

let running: Running | undefined;

afterEach(async () => {
    await running?.close();
    running = undefined;
});

async function start(auth: Record<string, unknown>, overridden: string[] = [], now?: () => number): Promise<Running> {
    const dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-auth-'));
    const path = join(dir, 'mqtt2matter.json');
    const raw: Record<string, unknown> = {storage: join(dir, 'data'), server: {auth}};
    await writeFile(path, JSON.stringify(raw));
    const config = parseConfig(raw);
    const logBuffer = new LogBuffer();
    const log = createLogger('error', logBuffer.sink);
    const app = new App(config, {log});
    const created = await Auth.create(config.server.auth, now);
    const server = new Server({
        app,
        store: new ConfigStore({path, raw, config, overridden}),
        log,
        logBuffer,
        version: 'test',
        host: '127.0.0.1',
        port: 0,
        uiDir: join(dir, 'no-ui'),
        auth: created.auth,
    });
    await server.listen();
    running = {
        base: `http://127.0.0.1:${server.port}`,
        dir,
        path,
        close: async () => {
            await server.close();
            await rm(dir, {recursive: true, force: true});
        },
    };
    return running;
}

async function call(
    method: string,
    path: string,
    options: {body?: unknown; headers?: Record<string, string>} = {},
): Promise<{status: number; json: any; cookie: string | null}> {
    const response = await fetch(`${running!.base}${path}`, {
        method,
        headers: {
            ...(options.body === undefined ? {} : {'content-type': 'application/json'}),
            ...options.headers,
        },
        ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
    });
    const text = await response.text();
    return {
        status: response.status,
        json: text === '' ? undefined : JSON.parse(text),
        cookie: response.headers.get('set-cookie'),
    };
}

/** the event stream: 'open' or the status the upgrade was refused with */
function stream(headers: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${running!.base.replace('http', 'ws')}/api/events`, {headers});
        ws.on('open', () => {
            ws.close();
            resolve('open');
        });
        ws.on('unexpected-response', (_request, response) => {
            resolve(String(response.statusCode));
            ws.terminate();
        });
        ws.on('error', () => {
            resolve('error');
        });
    });
}

const session = (cookie: string | null): string => /mqtt2matter_session=[a-f0-9]{64}/.exec(cookie ?? '')?.[0] ?? '';

describe('the password hash', () => {
    it('is scrypt, salted, verified in constant time', async () => {
        const hash = await hashPassword('secret');
        expect(isPasswordHash(hash)).toBe(true);
        expect(hash).not.toBe(await hashPassword('secret'));
        expect(await verifyPassword('secret', hash)).toBe(true);
        expect(await verifyPassword('Secret', hash)).toBe(false);
        expect(await verifyPassword('secret', 'secret')).toBe(false);
    });

    it('a plain password in the settings is hashed at start and reported', async () => {
        const {auth, plain} = await Auth.create({
            mode: 'password',
            password: 'secret',
            proxyHeader: 'X',
            sessionHours: 1,
        });
        expect(plain).toBe(true);
        expect(isPasswordHash(auth.passwordHash!)).toBe(true);
    });
});

describe('mode none', () => {
    it('everything is open, the event stream too', async () => {
        await start({});
        expect((await call('GET', '/api/log')).status).toBe(200);
        expect((await call('GET', '/api/auth')).json).toEqual({mode: 'none', authenticated: true});
        expect(await stream()).toBe('open');
        expect((await call('POST', '/api/auth/login', {body: {password: 'x'}})).status).toBe(400);
    });
});

describe('mode password', () => {
    it('refuses the API and the event stream until a login; the session cookie opens both', async () => {
        await start({mode: 'password', password: await hashPassword('secret')});
        expect((await call('GET', '/api/log')).status).toBe(401);
        expect((await call('GET', '/api/config')).status).toBe(401);
        expect(await stream()).toBe('401');
        expect((await call('GET', '/api/auth')).json).toEqual({mode: 'password', authenticated: false});

        const wrong = await call('POST', '/api/auth/login', {body: {password: 'guess'}});
        expect(wrong.status).toBe(401);
        expect(wrong.cookie).toBeNull();

        const login = await call('POST', '/api/auth/login', {body: {password: 'secret'}});
        expect(login.status).toBe(200);
        expect(login.cookie).toMatch(
            /^mqtt2matter_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/,
        );
        const cookie = session(login.cookie);
        expect((await call('GET', '/api/log', {headers: {cookie}})).status).toBe(200);
        expect((await call('GET', '/api/auth', {headers: {cookie}})).json.authenticated).toBe(true);
        expect(await stream({cookie})).toBe('open');
        // the hash never leaves the server
        const config = await call('GET', '/api/config', {headers: {cookie}});
        expect(config.json.effective.server.auth.password).toBe('***');

        const logout = await call('POST', '/api/auth/logout', {headers: {cookie}});
        expect(logout.cookie).toContain('Max-Age=0');
        expect((await call('GET', '/api/log', {headers: {cookie}})).status).toBe(401);
        expect(await stream({cookie})).toBe('401');
    });

    it('a cookie behind a TLS proxy is Secure', async () => {
        await start({mode: 'password', password: 'secret'});
        const login = await call('POST', '/api/auth/login', {
            body: {password: 'secret'},
            headers: {'x-forwarded-proto': 'https'},
        });
        expect(login.cookie).toContain('; Secure');
    });

    it('throttles failed logins per address', async () => {
        await start({mode: 'password', password: 'secret'});
        for (let i = 0; i < 10; i++) {
            expect((await call('POST', '/api/auth/login', {body: {password: 'guess'}})).status).toBe(401);
        }
        expect((await call('POST', '/api/auth/login', {body: {password: 'secret'}})).status).toBe(429);
    });

    it('a session expires', async () => {
        let now = 1_000_000;
        await start({mode: 'password', password: 'secret', sessionHours: 1}, [], () => now);
        const cookie = session((await call('POST', '/api/auth/login', {body: {password: 'secret'}})).cookie);
        expect((await call('GET', '/api/log', {headers: {cookie}})).status).toBe(200);
        now += 3601 * 1000;
        expect((await call('GET', '/api/log', {headers: {cookie}})).status).toBe(401);
    });
});

describe('mode proxy', () => {
    it('trusts the header the proxy sets, refuses a request without it', async () => {
        await start({mode: 'proxy', proxyLogoutUrl: 'https://sso.example.org/logout'});
        expect((await call('GET', '/api/log')).status).toBe(401);
        expect((await call('GET', '/api/log', {headers: {'x-remote-user': ''}})).status).toBe(401);
        expect(await stream()).toBe('401');
        const headers = {'X-Remote-User': 'alice'};
        expect((await call('GET', '/api/log', {headers})).status).toBe(200);
        expect(await stream(headers)).toBe('open');
        expect((await call('GET', '/api/auth', {headers})).json).toEqual({
            mode: 'proxy',
            authenticated: true,
            user: 'alice',
            logoutUrl: 'https://sso.example.org/logout',
        });
    });

    it('a header of its own', async () => {
        await start({mode: 'proxy', proxyHeader: 'Remote-User'});
        expect((await call('GET', '/api/log', {headers: {'X-Remote-User': 'alice'}})).status).toBe(401);
        expect((await call('GET', '/api/log', {headers: {'Remote-User': 'alice'}})).status).toBe(200);
    });
});

describe('the access settings from the UI', () => {
    it('sets a password: written as a hash, applied at once, the caller stays logged in', async () => {
        const {path} = await start({});
        const set = await call('PUT', '/api/auth', {body: {mode: 'password', password: 'secret'}});
        expect(set.status).toBe(200);
        const cookie = session(set.cookie);
        expect(cookie).not.toBe('');
        expect((await call('GET', '/api/log')).status).toBe(401);
        expect((await call('GET', '/api/log', {headers: {cookie}})).status).toBe(200);
        const file = JSON.parse(await readFile(path, 'utf8'));
        expect(file.server.auth.mode).toBe('password');
        expect(isPasswordHash(file.server.auth.password)).toBe(true);
        expect(await verifyPassword('secret', file.server.auth.password)).toBe(true);

        // back to none: the hash is dropped
        expect((await call('PUT', '/api/auth', {body: {mode: 'none'}, headers: {cookie}})).status).toBe(200);
        expect(JSON.parse(await readFile(path, 'utf8')).server.auth).toEqual({mode: 'none'});
        expect((await call('GET', '/api/log')).status).toBe(200);
    });

    it('password mode needs a password; proxy mode only through the proxy', async () => {
        await start({});
        expect((await call('PUT', '/api/auth', {body: {mode: 'password'}})).status).toBe(400);
        expect((await call('PUT', '/api/auth', {body: {mode: 'nope'}})).status).toBe(400);
        expect((await call('PUT', '/api/auth', {body: {mode: 'proxy'}})).status).toBe(409);
        const viaProxy = await call('PUT', '/api/auth', {body: {mode: 'proxy'}, headers: {'X-Remote-User': 'bob'}});
        expect(viaProxy.status).toBe(200);
        expect((await call('GET', '/api/log')).status).toBe(401);
    });

    it('a mode the environment sets cannot be changed', async () => {
        await start({}, ['server.auth.mode']);
        expect((await call('PUT', '/api/auth', {body: {mode: 'password', password: 'x'}})).status).toBe(409);
        expect((await call('GET', '/api/log')).status).toBe(200);
    });
});
