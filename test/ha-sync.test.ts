/* The Home Assistant importer's API over a `devices` record: adopt, re-sync with the user's edits carried
   over and conflicts reported, a device announcing itself again with a change, an entity removed by an
   empty payload, the whole device gone (orphaned) and back (restored), manual and zigbee2mqtt devices
   untouched, the area and the native key carried through the report. */

import {describe, expect, it} from 'vitest';

import {ha} from '../src/importers/index.ts';
import type {DeviceInput, DevicesInput} from '../src/model/schema.ts';
import {CORPUS, loadCorpus} from './helpers/ha-corpus.ts';

const RELAY = 'ha:aa0000000002';
const SEEDLING = 'ha:aa0000000003';
const HUE = 'ha:zigbee2mqtt_0x00124b0000000001';

const statuses = (report: ha.SyncEntry[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of report) {
        counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
};
const entry = (report: ha.SyncEntry[], key: string): ha.SyncEntry => {
    const found = report.find((e) => e.key === key);
    if (found === undefined) {
        throw new Error(`no entry ${key}`);
    }
    return found;
};

function corpusSource(): ha.HaSource {
    const source = new ha.HaSource();
    loadCorpus(source, ...CORPUS);
    return source;
}

function adoptedCorpus(): {source: ha.HaSource; devices: DevicesInput} {
    const source = corpusSource();
    // zigbee2mqtt's own discovery is covered by its native description: adopted here on purpose (force)
    const discovery = source.discover();
    const keys = discovery.items.map((item) => item.key);
    return {source, devices: ha.adopt({}, discovery, {keys, force: true}).devices};
}

describe('adopt', () => {
    it('adds every supported device, keeps manual and zigbee2mqtt devices, reports the rest', () => {
        const manual: DeviceInput = {name: 'Mine', endpoints: [{deviceTypes: ['OnOffLight']}]};
        const z2m: DeviceInput = {
            name: 'Z',
            source: {kind: 'z2m', key: '0x1'},
            endpoints: [{deviceTypes: ['OnOffLight']}],
        };
        const source = corpusSource();
        const {devices, report} = ha.adopt({manual, z2m}, source.discover());
        expect(Object.keys(devices)).toHaveLength(33);
        expect(devices.manual).toBe(manual);
        expect(devices.z2m).toBe(z2m);
        expect(statuses(report)).toEqual({new: 31, covered: 5, unsupported: 7});
        expect(entry(report, RELAY)).toMatchObject({status: 'new', area: 'Küche', kind: 'device'});
        expect(entry(report, HUE)).toMatchObject({
            status: 'covered',
            native: 'z2m:0x00124b0000000001',
            covered: 'z2m:0x00124b0000000001',
        });
        expect(devices[HUE]).toBeUndefined();
        expect(entry(report, 'ha:cam00001').status).toBe('unsupported');
        expect(entry(report, 'ha:cam00001').device).toBeUndefined();
        expect(entry(report, 'ha:cam00001').notes).toEqual(['nothing of its entities maps onto Matter']);
    });

    it('adopts only the selected keys', () => {
        const source = corpusSource();
        const {devices, report} = ha.adopt({}, source.discover(), {keys: [RELAY]});
        expect(Object.keys(devices)).toEqual([RELAY]);
        expect(statuses(report).new).toBe(31);
    });

    it('a second adopt over the same discovery changes nothing', () => {
        const {source, devices} = adoptedCorpus();
        const {devices: again, report} = ha.adopt(devices, source.discover());
        expect(again).toEqual(devices);
        expect(statuses(report)).toEqual({unchanged: 36, unsupported: 7});
        expect(entry(report, RELAY).area).toBe('Küche');
    });
});

describe('re-sync', () => {
    it('a renamed device: updated, the name follows, an edited mapping survives', () => {
        const {source, devices} = adoptedCorpus();
        // the user edits the command topic of the relay
        const relay = structuredClone(devices[RELAY]!);
        const onOff = relay.endpoints[0]!.mappings![0]!;
        onOff.command = {...onOff.command!, topic: 'usb-relay-02/set/relay/custom'};
        devices[RELAY] = relay;
        // the device announces itself again with a new name (every entity repeats the device block)
        for (const e of [...source.entities.values()].filter((e) => e.topic.includes('/usb-relay-02/'))) {
            source.handle(e.topic, JSON.stringify({...e.config, device: {...e.config.device, name: 'Fairy lights 2'}}));
        }
        const report = ha.diff(source.discover(), devices);
        expect(entry(report, RELAY)).toMatchObject({status: 'updated', edits: 1, conflicts: []});
        const {devices: synced} = ha.adopt(devices, source.discover());
        expect(synced[RELAY]!.name).toBe('Fairy lights 2');
        expect(synced[RELAY]!.endpoints[0]!.mappings![0]!.command!.topic).toBe('usb-relay-02/set/relay/custom');
        expect(synced[RELAY]!.source!.version).not.toBe(devices[RELAY].source!.version);
    });

    it('a conflict: the user and the source changed the same value; the user wins, the conflict is reported', () => {
        const {source, devices} = adoptedCorpus();
        const relay = structuredClone(devices[RELAY]!);
        relay.endpoints[0]!.mappings![0]!.status = {topic: 'mine/state', map: {ON: true, OFF: false}};
        devices[RELAY] = relay;
        const config = source.entities.get('homeassistant/switch/usb-relay-02/relay/config')!.config;
        source.handle(
            'homeassistant/switch/usb-relay-02/relay/config',
            JSON.stringify({...config, state_topic: 'usb-relay-02/status/relay2'}),
        );
        const report = ha.diff(source.discover(), devices);
        const e = entry(report, RELAY);
        expect(e.status).toBe('updated');
        expect(e.conflicts).toEqual([
            {
                path: 'endpoints.main.mappings.attribute:OnOff.onOff.status.topic',
                op: 'set',
                user: 'mine/state',
                before: 'usb-relay-02/status/relay',
                now: 'usb-relay-02/status/relay2',
                applied: true,
                reason: expect.any(String),
            },
        ]);
        expect(e.device!.endpoints[0]!.mappings![0]!.status!.topic).toBe('mine/state');
    });

    it('an entity removed by an empty payload: the device shrinks, a deleted endpoint is a change', () => {
        const {source, devices} = adoptedCorpus();
        expect(devices[SEEDLING]!.endpoints.map((e) => e.id ?? 'main')).toContain('light');
        source.handle('homeassistant/switch/seedling/light/config', '');
        const {devices: synced, report} = ha.adopt(devices, source.discover());
        expect(entry(report, SEEDLING).status).toBe('updated');
        expect(synced[SEEDLING]!.endpoints.map((e) => e.id ?? 'main')).not.toContain('light');
    });

    it('a device gone: orphaned, kept; back again: restored', () => {
        const {source, devices} = adoptedCorpus();
        const topics = [...source.entities.values()]
            .filter((e) => e.topic.includes('/usb-relay-02/'))
            .map((e) => e.topic);
        expect(topics.length).toBeGreaterThan(0);
        const kept = new Map(topics.map((t) => [t, source.entities.get(t)!.config]));
        for (const topic of topics) {
            source.handle(topic, '');
        }
        let report = ha.diff(source.discover(), devices);
        expect(entry(report, RELAY).status).toBe('orphaned');
        const {devices: orphaned} = ha.adopt(devices, source.discover());
        expect(orphaned[RELAY]!.source!.orphaned).toBe(true);
        expect(ha.orphaned(orphaned)).toEqual([RELAY]);
        // nothing is removed; the adopt with orphan: false leaves it unmarked
        expect(ha.adopt(devices, source.discover(), {orphan: false}).devices[RELAY]!.source!.orphaned).toBeUndefined();
        for (const [topic, config] of kept) {
            source.handle(topic, JSON.stringify(config));
        }
        report = ha.diff(source.discover(), orphaned);
        expect(entry(report, RELAY).status).toBe('restored');
        const {devices: restored} = ha.adopt(orphaned, source.discover());
        expect(restored[RELAY]!.source!.orphaned).toBeUndefined();
    });

    it('nothing seen yet: nothing is orphaned', () => {
        const {devices} = adoptedCorpus();
        const empty = new ha.HaSource();
        const report = ha.diff(empty.discover(), devices);
        expect(statuses(report)).toEqual({unchanged: 36});
        expect(entry(report, RELAY).notes).toEqual(['no discovery message seen yet; cannot tell']);
    });

    it('a device without a usable raw is kept as it is, its source refreshed', () => {
        const {source, devices} = adoptedCorpus();
        const relay = structuredClone(devices[RELAY]!);
        relay.source = {kind: 'ha-discovery', key: 'aa0000000002'};
        relay.name = 'Hand-written';
        devices[RELAY] = relay;
        const {devices: synced, report} = ha.adopt(devices, source.discover());
        expect(entry(report, RELAY)).toMatchObject({
            status: 'unchanged',
            notes: ['no baseline in source.raw; the device was kept as it is'],
        });
        expect(synced[RELAY]!.name).toBe('Hand-written');
        expect(synced[RELAY]!.source!.raw).toBeDefined();
    });

    it("edits: the user's changes against the baseline", () => {
        const {devices} = adoptedCorpus();
        const relay = structuredClone(devices[RELAY]!);
        expect(ha.edits(relay)).toEqual([]);
        relay.name = 'Renamed';
        expect(ha.edits(relay)).toMatchObject([{op: 'set', path: ['name'], value: 'Renamed'}]);
    });
});
