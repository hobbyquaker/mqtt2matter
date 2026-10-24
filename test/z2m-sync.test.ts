/* The importer's API over a `devices` record: adopt, re-sync with the user's edits carried over,
   conflicts reported, renames, definition changes, orphaning and restoring, groups following their
   members, manual devices untouched. The corpus of test/fixtures/z2m is the zigbee2mqtt side. */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {z2m} from '../src/importers/index.ts';
import {TopicCache} from '../src/mqtt/topic-cache.ts';
import type {DeviceInput, DevicesInput} from '../src/model/schema.ts';

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');
const corpusDevices = (): z2m.BridgeDevice[] =>
    z2m.parseBridgeDevices(readFileSync(join(fixtures, 'bridge-devices.json')));
const corpusGroups = (): z2m.BridgeGroup[] => z2m.parseBridgeGroups(readFileSync(join(fixtures, 'bridge-groups.json')));

const LIGHT = 'z2m:0xa4c138071003495f';
const CONTACT = 'z2m:0x00158d00091e7bd6';
const COVER = 'z2m:0x70ac08fffee6dd5e';
const LIGHTS_GROUP = 'z2m:group:7';

const statuses = (report: z2m.SyncEntry[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of report) {
        counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
};
const entry = (report: z2m.SyncEntry[], key: string): z2m.SyncEntry => {
    const found = report.find((e) => e.key === key);
    if (found === undefined) {
        throw new Error(`no entry ${key}`);
    }
    return found;
};
const clone = <T>(value: T): T => structuredClone(value);

function adoptedCorpus(): DevicesInput {
    const {devices} = z2m.adopt({}, z2m.discover({devices: corpusDevices(), groups: corpusGroups()}));
    return devices;
}

describe('adopt', () => {
    it('adds every supported device and group, keeps manual devices, reports the rest', () => {
        const manual: DeviceInput = {name: 'Mine', endpoints: [{deviceTypes: ['OnOffLight']}]};
        const discovery = z2m.discover({devices: corpusDevices(), groups: corpusGroups()});
        const {devices, report} = z2m.adopt({manual}, discovery);
        expect(Object.keys(devices)).toHaveLength(38);
        expect(Object.keys(devices)[0]).toBe('manual');
        expect(devices.manual).toBe(manual);
        expect(statuses(report)).toEqual({new: 37, unsupported: 8});
        expect(entry(report, 'z2m:group:10')).toMatchObject({
            status: 'unsupported',
            notes: ['the members are neither lights, switches nor covers'],
        });
        expect(entry(report, LIGHT).unmapped).toEqual(['color_temp_startup', 'effect', 'linkquality']);
    });

    it('adopts only the selected new keys; the second run changes nothing', () => {
        const discovery = z2m.discover({devices: corpusDevices(), groups: corpusGroups()});
        const first = z2m.adopt({}, discovery, {keys: [LIGHT, LIGHTS_GROUP]});
        expect(Object.keys(first.devices)).toEqual([LIGHT, LIGHTS_GROUP]);
        const second = z2m.adopt(first.devices, discovery, {keys: []});
        expect(second.devices).toEqual(first.devices);
        expect(statuses(second.report)).toEqual({unchanged: 2, new: 35, unsupported: 8});
    });

    it('a full re-sync of an untouched config is a no-op', () => {
        const devices = adoptedCorpus();
        const again = z2m.adopt(clone(devices), z2m.discover({devices: corpusDevices(), groups: corpusGroups()}));
        expect(again.devices).toEqual(devices);
        expect(statuses(again.report)).toEqual({unchanged: 37, unsupported: 8});
        expect(again.report.every((e) => e.conflicts.length === 0 && e.edits === 0)).toBe(true);
    });
});

describe('re-sync', () => {
    it('carries an edited mapping, a dropped one and an added one over a rename; the name edit conflicts', () => {
        const devices = adoptedCorpus();
        const light = devices[LIGHT]!;
        const main = light.endpoints[0]!;
        main.mappings![0]!.command!.format = {true: 'on', false: 'off'};
        main.mappings = main.mappings!.filter((b) => !('attribute' in b && b.attribute === 'ColorControl.colorMode'));
        main.mappings.push({
            invoke: 'Identify.identify',
            command: {topic: 'zigbee2mqtt/Gledopto RGBCTT light I/set', wrap: 'effect', payload: 'blink'},
        });
        main.options = {...main.options, light: {...main.options?.light, onCommandType: 'first'}};
        light.name = 'Kitchen ceiling';
        light.bridge = 'second';

        const renamed = corpusDevices();
        renamed.find((d) => d.ieee_address === '0xa4c138071003495f')!.friendly_name = 'Kitchen';
        const {devices: synced, report} = z2m.adopt(devices, z2m.discover({devices: renamed, groups: corpusGroups()}));
        const e = entry(report, LIGHT);
        expect(e.status).toBe('updated');
        expect(e.edits).toBeGreaterThan(0);
        expect(e.conflicts).toEqual([
            expect.objectContaining({
                path: 'name',
                user: 'Kitchen ceiling',
                before: 'Gledopto RGBCTT light I',
                now: 'Kitchen',
                applied: true,
            }),
        ]);
        const result = synced[LIGHT]!;
        expect(result.name).toBe('Kitchen ceiling');
        expect(result.bridge).toBe('second');
        expect(result.availability).toMatchObject({topic: 'zigbee2mqtt/Kitchen/availability'});
        const mappings = result.endpoints[0]!.mappings!;
        expect(mappings[0]).toEqual({
            attribute: 'OnOff.onOff',
            status: {
                topic: 'zigbee2mqtt/Kitchen',
                extract: 'state',
                map: {ON: true, OFF: false},
                get: {topic: 'zigbee2mqtt/Kitchen/get', payload: '{"state":""}'},
            },
            command: {topic: 'zigbee2mqtt/Kitchen/set', wrap: 'state', format: {true: 'on', false: 'off'}},
        });
        expect(mappings.some((b) => 'attribute' in b && b.attribute === 'ColorControl.colorMode')).toBe(false);
        // the added mapping keeps its (now stale) topic: it is the user's, not the importer's
        expect(mappings.at(-1)).toMatchObject({
            invoke: 'Identify.identify',
            command: {topic: 'zigbee2mqtt/Gledopto RGBCTT light I/set'},
        });
        expect(result.endpoints[0]!.options).toEqual({light: {minMireds: 158, maxMireds: 495, onCommandType: 'first'}});
        expect(result.source).toMatchObject({kind: 'z2m', key: '0xa4c138071003495f'});
        expect(result.source!.version).not.toBe(light.source!.version);
        expect((result.source!.raw as z2m.RawDevice).friendly_name).toBe('Kitchen');
        // the other devices did not move
        expect(statuses(report)).toEqual({updated: 1, unchanged: 36, unsupported: 8});
    });

    it('a definition change regenerates the baseline; an edit on what disappeared is reported, not applied', () => {
        const devices = adoptedCorpus();
        const light = devices[LIGHT]!;
        const xy = light.endpoints[0]!.mappings!.find(
            (b) => 'attribute' in b && b.attribute === 'ColorControl.colorXy',
        )!;
        xy.comment = 'mine';
        const changed = corpusDevices();
        const definition = changed.find((d) => d.ieee_address === '0xa4c138071003495f')!.definition!;
        const lightExpose = definition.exposes!.find((e) => e.type === 'light')!;
        lightExpose.features = lightExpose.features!.filter((f) => f.name !== 'color_xy' && f.name !== 'color_hs');
        const {devices: synced, report} = z2m.adopt(devices, z2m.discover({devices: changed, groups: corpusGroups()}));
        const e = entry(report, LIGHT);
        expect(e.status).toBe('updated');
        expect(e.conflicts).toEqual([
            expect.objectContaining({
                path: 'endpoints.main.mappings.attribute:ColorControl.colorXy.comment',
                applied: false,
            }),
        ]);
        const result = synced[LIGHT]!;
        expect(result.endpoints[0]!.deviceTypes).toEqual(['ColorTemperatureLight']);
        expect(result.endpoints[0]!.mappings!.map((b) => ('attribute' in b ? b.attribute : ''))).toEqual([
            'OnOff.onOff',
            'LevelControl.currentLevel',
            'ColorControl.colorTemperatureMireds',
        ]);
    });

    it('a merge that does not validate leaves the device as it was', () => {
        const devices = adoptedCorpus();
        const cover = devices[COVER]!;
        cover.endpoints[0]!.options = {cover: {reportTimeout: 'soon' as unknown as number}};
        const renamed = corpusDevices();
        renamed.find((d) => d.ieee_address === '0x70ac08fffee6dd5e')!.friendly_name = 'Shutter';
        const {devices: synced, report} = z2m.adopt(
            clone(devices),
            z2m.discover({devices: renamed, groups: corpusGroups()}),
        );
        const e = entry(report, COVER);
        expect(e.status).toBe('invalid');
        expect(e.notes[0]).toMatch(/reportTimeout/);
        expect(synced[COVER]).toEqual(cover);
    });

    it('without a baseline in source.raw the device is kept and the source refreshed', () => {
        const devices = adoptedCorpus();
        const contact = devices[CONTACT]!;
        contact.source = {kind: 'z2m', key: '0x00158d00091e7bd6'};
        contact.name = 'Front door';
        const {devices: synced, report} = z2m.adopt(
            clone(devices),
            z2m.discover({devices: corpusDevices(), groups: corpusGroups()}),
        );
        expect(entry(report, CONTACT)).toMatchObject({
            status: 'unchanged',
            notes: ['no baseline in source.raw; the device was kept as it is'],
        });
        expect(synced[CONTACT]!.name).toBe('Front door');
        expect(z2m.isRaw(synced[CONTACT]!.source!.raw)).toBe(true);
    });

    it('resync: false keeps the devices as they are', () => {
        const devices = adoptedCorpus();
        const renamed = corpusDevices();
        renamed.find((d) => d.ieee_address === '0xa4c138071003495f')!.friendly_name = 'Kitchen';
        const {devices: synced, report} = z2m.adopt(
            clone(devices),
            z2m.discover({devices: renamed, groups: corpusGroups()}),
            {resync: false},
        );
        expect(synced[LIGHT]).toEqual(devices[LIGHT]);
        expect(entry(report, LIGHT).status).toBe('unchanged');
    });
});

describe('orphaning', () => {
    it('a device gone from bridge/devices is marked, never removed; back again it is restored', () => {
        const devices = adoptedCorpus();
        const without = corpusDevices().filter((d) => d.ieee_address !== '0x00158d00091e7bd6');
        const {devices: synced, report} = z2m.adopt(
            clone(devices),
            z2m.discover({devices: without, groups: corpusGroups()}),
        );
        expect(entry(report, CONTACT).status).toBe('orphaned');
        expect(synced[CONTACT]).toEqual({...devices[CONTACT], source: {...devices[CONTACT]!.source, orphaned: true}});
        expect(z2m.orphaned(synced)).toEqual([CONTACT]);
        expect(Object.keys(synced)).toEqual(Object.keys(devices));

        const back = z2m.adopt(clone(synced), z2m.discover({devices: corpusDevices(), groups: corpusGroups()}));
        expect(entry(back.report, CONTACT).status).toBe('restored');
        expect(back.devices[CONTACT]).toEqual(devices[CONTACT]);
        expect(z2m.orphaned(back.devices)).toEqual([]);
    });

    it('nothing is orphaned while the bridge topic was not seen; orphan: false keeps the flag off', () => {
        const devices = adoptedCorpus();
        const onlyGroups = z2m.adopt(clone(devices), z2m.discover({groups: corpusGroups()}));
        expect(z2m.orphaned(onlyGroups.devices)).toEqual([]);
        expect(entry(onlyGroups.report, CONTACT)).toMatchObject({
            status: 'unchanged',
            notes: ['no bridge/devices seen; cannot tell'],
        });
        expect(entry(onlyGroups.report, LIGHTS_GROUP)).toMatchObject({
            status: 'unchanged',
            notes: ['no bridge/groups (with bridge/devices) seen; cannot tell'],
        });

        const noGroups = z2m.adopt(clone(devices), z2m.discover({devices: corpusDevices()}));
        expect(entry(noGroups.report, LIGHTS_GROUP).status).toBe('unchanged');
        expect(entry(noGroups.report, CONTACT).status).toBe('unchanged');

        const kept = z2m.adopt(clone(devices), z2m.discover({devices: corpusDevices(), groups: []}), {orphan: false});
        expect(entry(kept.report, LIGHTS_GROUP).status).toBe('unchanged');
        expect(kept.devices[LIGHTS_GROUP]).toEqual(devices[LIGHTS_GROUP]);
    });

    it('a group that lost all members is unsupported and kept as it is', () => {
        const devices = adoptedCorpus();
        const groups = corpusGroups();
        groups.find((g) => g.id === 7)!.members = [];
        const {devices: synced, report} = z2m.adopt(clone(devices), z2m.discover({devices: corpusDevices(), groups}));
        expect(entry(report, LIGHTS_GROUP)).toMatchObject({status: 'unsupported', notes: ['no members']});
        expect(synced[LIGHTS_GROUP]).toEqual(devices[LIGHTS_GROUP]);
    });
});

describe('groups follow their members', () => {
    it('a member that only switches turns the union into a light group still; a cover-only group is a cover', () => {
        const devices = adoptedCorpus();
        const groups = corpusGroups();
        // the switches group gains a light: it becomes a light group
        groups.find((g) => g.id === 8)!.members.push({ieee_address: '0x04cd15fffeddccd4', endpoint: 1});
        const {devices: synced, report} = z2m.adopt(clone(devices), z2m.discover({devices: corpusDevices(), groups}));
        expect(entry(report, 'z2m:group:8').status).toBe('updated');
        expect(synced['z2m:group:8']!.endpoints[0]!.deviceTypes).toEqual(['DimmableLight']);
        expect((synced['z2m:group:8']!.source!.raw as z2m.RawGroup).union).toMatchObject({
            kind: 'light',
            brightness: true,
            members: 6,
        });
    });
});

describe('diff', () => {
    it('describes what adopting would do without touching the record', () => {
        const devices = adoptedCorpus();
        const before = clone(devices);
        const without = corpusDevices().filter((d) => d.ieee_address !== '0x00158d00091e7bd6');
        const report = z2m.diff(z2m.discover({devices: without, groups: corpusGroups()}), devices);
        expect(devices).toEqual(before);
        expect(statuses(report)).toEqual({unchanged: 36, orphaned: 1, unsupported: 8});
        expect(entry(report, CONTACT).device!.source!.orphaned).toBe(true);
    });

    it("lists the user's edits of a device", () => {
        const devices = adoptedCorpus();
        expect(z2m.edits(devices[LIGHT]!)).toEqual([]);
        devices[LIGHT]!.name = 'Other';
        expect(z2m.edits(devices[LIGHT]!)).toEqual([{op: 'set', path: ['name'], value: 'Other'}]);
    });
});

describe('Z2mSource', () => {
    it('takes the bridge topics from messages or the cache and rejects other payloads', () => {
        const source = new z2m.Z2mSource('zigbee');
        expect(source.topics).toEqual(['zigbee/bridge/devices', 'zigbee/bridge/groups']);
        expect(source.handle('zigbee/light', '{}')).toBeUndefined();
        expect(source.handle('zigbee/bridge/devices', readFileSync(join(fixtures, 'bridge-devices.json')))).toBe(
            'devices',
        );
        expect(source.devices).toHaveLength(35);
        expect(() => source.handle('zigbee/bridge/groups', '{"not": "a list"}')).toThrow(/not an array/);
        expect(() => source.handle('zigbee/bridge/devices', '[{"x": 1}]')).toThrow(/ieee_address/);
        const discovery = source.discover();
        expect(discovery.sawDevices).toBe(true);
        expect(discovery.sawGroups).toBe(false);
        expect(discovery.baseTopic).toBe('zigbee');
        expect(discovery.items[1]!.baseline!.availability).toMatchObject({topic: 'zigbee/Climate sensor/availability'});

        const cache = new TopicCache();
        cache.store('zigbee/bridge/groups', readFileSync(join(fixtures, 'bridge-groups.json')), true);
        source.load(cache);
        expect(source.groups).toHaveLength(10);
        expect(source.discover().sawGroups).toBe(true);
    });
});
