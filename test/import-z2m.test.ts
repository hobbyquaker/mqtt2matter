/* `mqtt2matter --import-z2m` against an in-process broker holding the corpus as retained bridge topics:
   the file is written with the adopted devices, a second run re-syncs, a device gone from zigbee2mqtt is
   orphaned, a dry run writes nothing, a missing bridge topic is an error. */

import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {formatReport, importZ2m, parseImportArgs} from '../src/commands/import-z2m.ts';
import {ConfigError} from '../src/config/load.ts';
import type {DevicesInput} from '../src/model/schema.ts';
import {startBroker, type Broker} from './helpers/broker.ts';

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');

let broker: Broker;
let dir: string;
let client: MqttClient;

beforeAll(async () => {
    broker = await startBroker();
    dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-import-'));
    client = await mqtt.connectAsync(broker.url);
    await client.publishAsync('zigbee2mqtt/bridge/devices', readFileSync(join(fixtures, 'bridge-devices.json')), {
        retain: true,
    });
    await client.publishAsync('zigbee2mqtt/bridge/groups', readFileSync(join(fixtures, 'bridge-groups.json')), {
        retain: true,
    });
}, 30_000);

afterAll(async () => {
    await client.endAsync();
    await broker.close();
    await rm(dir, {recursive: true, force: true});
});

async function run(args: string[], env: Record<string, string | undefined> = {}): Promise<string[]> {
    const out: string[] = [];
    const code = await importZ2m(parseImportArgs(args), {out: (line) => out.push(line), env: {...env}});
    expect(code).toBe(0);
    return out;
}

describe('parseImportArgs', () => {
    it('reads the options and the file', () => {
        expect(parseImportArgs(['my.json', '--base-topic', 'zb', '--dry-run', '--no-groups', '--timeout=3'])).toEqual({
            configPath: 'my.json',
            baseTopic: 'zb',
            dryRun: true,
            groups: false,
            timeout: 3,
        });
        expect(parseImportArgs([])).toEqual({baseTopic: 'zigbee2mqtt', dryRun: false, groups: true, timeout: 15});
        expect(() => parseImportArgs(['--what'])).toThrow(ConfigError);
        expect(() => parseImportArgs(['--timeout', 'x'])).toThrow(ConfigError);
    });
});

describe('importZ2m', () => {
    it('adopts the corpus into the file and keeps everything else in it', async () => {
        const path = join(dir, 'a.json');
        await writeFile(
            path,
            JSON.stringify({
                mqtt: {url: broker.url},
                log: {level: 'warn'},
                devices: {mine: {name: 'Mine', endpoints: [{deviceTypes: ['OnOffLight']}]}},
            }),
        );
        const out = await run([path, '--timeout', '10']);
        expect(out.at(-1)).toMatch(/^written .*a\.json: 39 devices$/);
        expect(out).toContain('38 new, 0 updated, 0 unchanged, 0 orphaned, 0 invalid, 7 unsupported');
        expect(
            out.some((l) =>
                l.startsWith('+ new         z2m:0xa4c138071003495f  Gledopto RGBCTT light I  main: ExtendedColorLight'),
            ),
        ).toBe(true);
        expect(out.some((l) => l.startsWith('+ new         z2m:group:10  Thermostats  main: OnOffPlugInUnit'))).toBe(
            true,
        );
        expect(out.some((l) => l.startsWith('ERROR'))).toBe(false);
        const written = JSON.parse(await readFile(path, 'utf8')) as {
            mqtt: unknown;
            log: unknown;
            devices: DevicesInput;
        };
        expect(written.mqtt).toEqual({url: broker.url});
        expect(written.log).toEqual({level: 'warn'});
        expect(Object.keys(written.devices)).toHaveLength(39);
        expect(written.devices.mine).toEqual({name: 'Mine', endpoints: [{deviceTypes: ['OnOffLight']}]});
        expect(written.devices['z2m:0x00158d000945f2b1']!.source).toMatchObject({
            kind: 'z2m',
            key: '0x00158d000945f2b1',
        });

        // the second run: nothing changes
        const again = await run([path, '--timeout', '10']);
        expect(again).toContain('0 new, 0 updated, 38 unchanged, 0 orphaned, 0 invalid, 7 unsupported');
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(written);
    }, 30_000);

    it('a device gone from zigbee2mqtt is orphaned, not removed; a dry run writes nothing', async () => {
        const path = join(dir, 'b.json');
        await writeFile(path, JSON.stringify({mqtt: {url: broker.url}}));
        await run([path, '--no-groups', '--timeout', '10']);
        const first = JSON.parse(await readFile(path, 'utf8')) as {devices: DevicesInput};
        expect(Object.keys(first.devices)).toHaveLength(34);

        const devices = JSON.parse(readFileSync(join(fixtures, 'bridge-devices.json'), 'utf8')) as {
            ieee_address: string;
        }[];
        await client.publishAsync(
            'zigbee2mqtt/bridge/devices',
            JSON.stringify(devices.filter((d) => d.ieee_address !== '0x00158d00091e7bd6')),
            {retain: true},
        );
        try {
            const dry = await run([path, '--no-groups', '--dry-run', '--timeout', '10']);
            expect(dry).toContain('0 new, 0 updated, 33 unchanged, 1 orphaned, 0 invalid, 1 unsupported');
            expect(dry.at(-1)).toMatch(/^dry run: .* not written$/);
            expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(first);

            await run([path, '--no-groups', '--timeout', '10']);
            const second = JSON.parse(await readFile(path, 'utf8')) as {devices: DevicesInput};
            expect(Object.keys(second.devices)).toHaveLength(34);
            expect(second.devices['z2m:0x00158d00091e7bd6']!.source!.orphaned).toBe(true);
        } finally {
            await client.publishAsync(
                'zigbee2mqtt/bridge/devices',
                readFileSync(join(fixtures, 'bridge-devices.json')),
                {retain: true},
            );
        }
    }, 30_000);

    it('the broker from the environment; no retained bridge topic is an error', async () => {
        const path = join(dir, 'c.json');
        await writeFile(path, '{}');
        await expect(
            importZ2m(parseImportArgs([path, '--base-topic', 'nowhere', '--timeout', '1']), {
                out: () => undefined,
                env: {MQTT2MATTER_MQTT_URL: broker.url},
            }),
        ).rejects.toThrow(/no retained nowhere\/bridge\/devices within 1 s/);
    }, 15_000);

    it('formats a report line per device', () => {
        expect(
            formatReport([
                {
                    key: 'z2m:0x1',
                    kind: 'device',
                    name: 'Lamp',
                    status: 'updated',
                    device: {
                        name: 'Lamp',
                        endpoints: [{deviceTypes: ['OnOffLight']}, {id: 'l2', deviceTypes: ['OnOffLight']}],
                    },
                    conflicts: [
                        {
                            path: 'name',
                            op: 'set',
                            user: 'Mine',
                            before: 'Lamp',
                            now: 'Kitchen',
                            applied: true,
                            reason: 'both changed',
                        },
                    ],
                    edits: 2,
                    unmapped: ['effect'],
                    notes: [],
                },
            ]),
        ).toEqual([
            '~ updated     z2m:0x1  Lamp  main: OnOffLight, l2: OnOffLight',
            '    conflict name: both changed (edit "Mine", importer "Kitchen")',
            '    not mapped: effect',
        ]);
    });
});
