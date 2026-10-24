/* The pairing code survives a restart: passcode and discriminator are generated once per bridge, persisted
   in `commissioning.json` and reused; configured values win. */

import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {CommissioningStore} from '../src/matter/commissioning.ts';
import {type Broker, startBroker} from './helpers/broker.ts';
import {freeUdpPort} from './helpers/util.ts';

describe('CommissioningStore', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-commissioning-'));
    });
    afterAll(async () => {
        await rm(dir, {recursive: true, force: true});
    });

    it('generates once, persists and reuses', async () => {
        const file = join(dir, 'a.json');
        const first = await CommissioningStore.load(file);
        const values = first.resolve('default', {});
        expect(values.passcode).toBeGreaterThanOrEqual(1);
        expect(values.passcode).toBeLessThanOrEqual(99999998);
        expect(values.discriminator).toBeGreaterThanOrEqual(0);
        expect(values.discriminator).toBeLessThanOrEqual(4095);
        expect(first.resolve('default', {})).toEqual(values);
        await first.save();
        const second = await CommissioningStore.load(file);
        expect(second.resolve('default', {})).toEqual(values);
        expect(second.resolve('other', {})).not.toEqual(values);
    });

    it('configured values win, a half-configured bridge keeps the other half stable', async () => {
        const file = join(dir, 'b.json');
        const store = await CommissioningStore.load(file);
        expect(store.resolve('full', {passcode: 20202021, discriminator: 3840})).toEqual({
            passcode: 20202021,
            discriminator: 3840,
        });
        const half = store.resolve('half', {passcode: 20202021});
        expect(half.passcode).toBe(20202021);
        await store.save();
        const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        // a fully configured bridge needs nothing remembered
        expect(Object.keys(saved)).toEqual(['half']);
        expect((await CommissioningStore.load(file)).resolve('half', {passcode: 20202021})).toEqual(half);
    });

    it('refuses a damaged file instead of silently changing the code', async () => {
        const file = join(dir, 'c.json');
        await writeFile(file, '{"default": {"passcode": 0, "discriminator": 1}}');
        await expect(CommissioningStore.load(file)).rejects.toThrow(/no valid passcode/);
    });
});

describe('two starts on the same storage', () => {
    let broker: Broker;
    let storage: string;

    beforeAll(async () => {
        broker = await startBroker();
        storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-restart-'));
    });
    afterAll(async () => {
        await broker.close();
        await rm(storage, {recursive: true, force: true});
    });

    async function manualCode(): Promise<string> {
        const config = parseConfig({
            mqtt: {url: broker.url},
            storage,
            log: {matter: 'error'},
            server: {enabled: false},
            bridges: {default: {port: await freeUdpPort()}},
            devices: {plug: {name: 'Plug', endpoints: [{deviceTypes: ['OnOffPlugInUnit']}]}},
        });
        const app = new App(config);
        await app.start();
        try {
            const [info] = app.nodes.info();
            expect(info?.commissioned).toBe(false);
            const code = info?.pairingCodes?.manualPairingCode;
            expect(code).toMatch(/^\d{11}$/);
            return code ?? '';
        } finally {
            await app.stop();
        }
    }

    it('give the same manual pairing code', async () => {
        const first = await manualCode();
        const second = await manualCode();
        expect(second).toBe(first);
        const saved = JSON.parse(await readFile(join(storage, 'commissioning.json'), 'utf8')) as Record<
            string,
            unknown
        >;
        expect(Object.keys(saved)).toEqual(['default']);
    }, 60_000);
});
