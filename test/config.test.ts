import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {applyEnv, ConfigError, configPath, loadConfig, parseConfig} from '../src/config/load.ts';

const plug = {
    name: 'Plug',
    endpoints: [
        {
            deviceTypes: ['OnOffPlugInUnit'],
            bindings: [
                {
                    attribute: 'OnOff.onOff',
                    status: {topic: 'stat/plug/POWER', map: {ON: true, OFF: false}},
                    command: {topic: 'cmnd/plug/POWER', format: {true: 'ON', false: 'OFF'}},
                },
            ],
        },
    ],
};

describe('parseConfig', () => {
    it('fills the defaults of an empty configuration', () => {
        const config = parseConfig({});
        expect(config.mqtt.url).toBe('mqtt://localhost:1883');
        expect(config.storage).toBe('./data');
        expect(config.log).toEqual({level: 'info', matter: 'warn'});
        expect(config.bridges).toEqual({default: {port: 5540, maxDevices: 0}});
        expect(config.devices).toEqual({});
        expect(config.vendorId).toBe(0xfff1);
    });

    it('fills the defaults inside a device', () => {
        const config = parseConfig({devices: {plug: plug}});
        const device = config.devices.plug!;
        expect(device.enabled).toBe(true);
        expect(device.source).toEqual({kind: 'manual'});
        expect(device.endpoints[0]!.id).toBe('main');
        expect(device.endpoints[0]!.bindings[0]!.command).toEqual({
            topic: 'cmnd/plug/POWER',
            format: {true: 'ON', false: 'OFF'},
            retain: false,
            qos: 0,
        });
    });

    it('rejects unknown keys, bad device keys, bad attribute names and empty bindings', () => {
        expect(() => parseConfig({mqtt: {host: 'x'}})).toThrow(ConfigError);
        expect(() => parseConfig({devices: {'bad key': plug}})).toThrow(/devices\["bad key"\]/);
        expect(() =>
            parseConfig({
                devices: {
                    p: {...plug, endpoints: [{deviceTypes: ['OnOffPlugInUnit'], bindings: [{attribute: 'onoff'}]}]},
                },
            }),
        ).toThrow(/Cluster\.attribute/);
        expect(() =>
            parseConfig({
                devices: {
                    p: {
                        ...plug,
                        endpoints: [{deviceTypes: ['OnOffPlugInUnit'], bindings: [{attribute: 'OnOff.onOff'}]}],
                    },
                },
            }),
        ).toThrow(/status half, a command half or both/);
        expect(() => parseConfig({bridges: {}})).toThrow(/at least one bridge/);
    });

    it('lists every problem with its path', () => {
        try {
            parseConfig({mqtt: {url: ''}, storage: 7});
            expect.unreachable();
        } catch (error) {
            expect((error as Error).message).toMatch(/mqtt\.url/);
            expect((error as Error).message).toMatch(/storage/);
        }
    });
});

describe('applyEnv', () => {
    it('writes the environment over the file', () => {
        const raw = applyEnv(
            {mqtt: {url: 'mqtt://file:1883', username: 'file'}, devices: {}},
            {
                MQTT2MATTER_MQTT_URL: 'mqtt://env:1883',
                MQTT2MATTER_MQTT_PASSWORD: 'secret',
                MQTT2MATTER_STORAGE: '/var/lib/mqtt2matter',
                MQTT2MATTER_LOG_LEVEL: 'debug',
                MQTT2MATTER_CONFIG: '/etc/ignored.json',
                UNRELATED: 'x',
            },
        );
        expect(raw).toEqual({
            mqtt: {url: 'mqtt://env:1883', username: 'file', password: 'secret'},
            devices: {},
            storage: '/var/lib/mqtt2matter',
            log: {level: 'debug'},
        });
        expect(parseConfig(raw).log).toEqual({level: 'debug', matter: 'warn'});
    });

    it('ignores empty values and does not touch the input', () => {
        const input = {mqtt: {url: 'a'}};
        expect(applyEnv(input, {MQTT2MATTER_MQTT_URL: ''})).toEqual(input);
        expect(applyEnv(input, {MQTT2MATTER_STORAGE: 'x'})).not.toBe(input);
        expect(input).toEqual({mqtt: {url: 'a'}});
    });
});

describe('configPath', () => {
    it('prefers the argument, then the environment, then the default', () => {
        expect(configPath(['node', 'main', 'a.json'], {MQTT2MATTER_CONFIG: 'b.json'})).toEqual({
            path: join(process.cwd(), 'a.json'),
            explicit: true,
        });
        expect(configPath(['node', 'main'], {MQTT2MATTER_CONFIG: 'b.json'})).toEqual({
            path: join(process.cwd(), 'b.json'),
            explicit: true,
        });
        expect(configPath(['node', 'main'], {})).toEqual({
            path: join(process.cwd(), 'mqtt2matter.json'),
            explicit: false,
        });
    });
});

describe('loadConfig', () => {
    let dir: string;
    afterEach(async () => {
        await rm(dir, {recursive: true, force: true});
    });

    it('reads a file and applies the environment', async () => {
        dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-config-'));
        const file = join(dir, 'c.json');
        await writeFile(file, JSON.stringify({devices: {plug}}));
        const loaded = await loadConfig({path: file, env: {MQTT2MATTER_MQTT_URL: 'mqtt://broker:1883'}});
        expect(loaded.fromFile).toBe(true);
        expect(loaded.config.mqtt.url).toBe('mqtt://broker:1883');
        expect(Object.keys(loaded.config.devices)).toEqual(['plug']);
    });

    it('treats a missing default file as empty, a missing explicit file as an error', async () => {
        dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-config-'));
        const missing = join(dir, 'missing.json');
        const loaded = await loadConfig({path: missing, explicit: false, env: {}});
        expect(loaded.fromFile).toBe(false);
        expect(loaded.config.bridges.default).toBeDefined();
        await expect(loadConfig({path: missing, env: {}})).rejects.toThrow(/cannot read/);
    });

    it('reports invalid JSON', async () => {
        dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-config-'));
        const file = join(dir, 'c.json');
        await writeFile(file, '{');
        await expect(loadConfig({path: file, env: {}})).rejects.toThrow(/not valid JSON/);
    });
});
