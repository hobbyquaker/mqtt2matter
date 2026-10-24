/* One Zigbee device, two descriptions: zigbee2mqtt's own (`bridge/devices`) and its Home Assistant
   discovery. Neither order of adopting yields two Matter devices without an explicit `force`; the native
   description is preferred, an adopted twin covers the other side, `replace` disables the twin. */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {ha, type SyncEntry, z2m} from '../src/importers/index.ts';
import {nativeKey} from '../src/importers/ha/generate.ts';
import type {DevicesInput} from '../src/model/schema.ts';

const IEEE = '0xa4c138071003495f';
const NATIVE = `z2m:${IEEE}`;

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');
const z2mDiscovery = (): z2m.Discovery =>
    z2m.discover({
        devices: z2m.parseBridgeDevices(readFileSync(join(fixtures, 'bridge-devices.json'))),
        groups: z2m.parseBridgeGroups(readFileSync(join(fixtures, 'bridge-groups.json'))),
    });

/** a switch entity of the device, as zigbee2mqtt (or another source) would announce it */
function haDiscovery(device: Record<string, unknown>, origin?: Record<string, unknown>): ha.Discovery {
    const source = new ha.HaSource();
    source.handle(
        `homeassistant/switch/${IEEE}/switch/config`,
        JSON.stringify({
            name: null,
            unique_id: `${IEEE}_switch`,
            state_topic: 'zigbee2mqtt/lamp',
            command_topic: 'zigbee2mqtt/lamp/set',
            value_template: '{{ value_json.state }}',
            payload_on: 'ON',
            payload_off: 'OFF',
            device: {name: 'Lamp', ...device},
            ...(origin === undefined ? {} : {origin}),
        }),
    );
    return source.discover();
}

const own = (): ha.Discovery => haDiscovery({identifiers: [`zigbee2mqtt_${IEEE}`]}, {name: 'Zigbee2MQTT', sw: '2.9.2'});
const HA_KEY = `ha:zigbee2mqtt_${IEEE}`;

const entry = (report: SyncEntry[], key: string): SyncEntry => {
    const found = report.find((e) => e.key === key);
    if (found === undefined) {
        throw new Error(`no entry ${key}`);
    }
    return found;
};

describe('the native key', () => {
    it("is read from zigbee2mqtt's identifiers, with and without an origin", () => {
        expect(nativeKey(`zigbee2mqtt_${IEEE}`)).toBe(NATIVE);
        expect(nativeKey('zigbee2mqtt_1000000000000000000000000000001_7')).toBe('z2m:group:7');
        const item = haDiscovery({identifiers: [`zigbee2mqtt_${IEEE}`]}).items[0];
        expect(item?.native).toBe(NATIVE);
    });

    it('from a Zigbee connection or a 0x address among the identifiers of another source', () => {
        expect(nativeKey('acme-1', {connections: [['zigbee', 'A4:C1:38:07:10:03:49:5F']]})).toBe(NATIVE);
        expect(nativeKey('acme-1', {connections: [['ieee', IEEE]]})).toBe(NATIVE);
        expect(nativeKey('acme-1', {identifiers: ['acme-1', IEEE.toUpperCase().replace('0X', '0x')]})).toBe(NATIVE);
        // a MAC is not a Zigbee address, 16 hex digits without 0x may be any serial number
        expect(nativeKey('acme-1', {connections: [['mac', 'aa:bb:cc:dd:ee:ff']]})).toBeUndefined();
        expect(nativeKey('a4c138071003495f')).toBeUndefined();
    });
});

describe('HA discovery of a device zigbee2mqtt describes natively', () => {
    it('is covered and not adopted, not even when named, unless forced', () => {
        const discovery = own();
        expect(entry(ha.diff(discovery, {}), HA_KEY)).toMatchObject({status: 'covered', covered: NATIVE});
        expect(ha.adopt({}, discovery).devices).toEqual({});
        expect(ha.adopt({}, discovery, {keys: [HA_KEY]}).devices).toEqual({});
        // force without naming the key is not enough: "adopt everything" never takes a covered entry
        expect(ha.adopt({}, discovery, {force: true}).devices).toEqual({});
        expect(Object.keys(ha.adopt({}, discovery, {keys: [HA_KEY], force: true}).devices)).toEqual([HA_KEY]);
    });

    it('is covered by a configured native twin even without an origin (detected by the IEEE)', () => {
        const native = z2m.adopt({}, z2mDiscovery(), {keys: [NATIVE]}).devices;
        const discovery = haDiscovery({identifiers: ['acme-1'], connections: [['zigbee', IEEE]]});
        const report = ha.diff(discovery, native);
        expect(entry(report, 'ha:acme-1')).toMatchObject({status: 'covered', covered: NATIVE, twins: [NATIVE]});
    });
});

describe('zigbee2mqtt after its device was adopted through HA discovery', () => {
    function haFirst(): DevicesInput {
        return ha.adopt({}, own(), {keys: [HA_KEY], force: true}).devices;
    }

    it('reports the native device as covered by the HA twin; "adopt all new" leaves it', () => {
        const devices = haFirst();
        const report = z2m.diff(z2mDiscovery(), devices);
        expect(entry(report, NATIVE)).toMatchObject({status: 'covered', covered: HA_KEY, twins: [HA_KEY]});
        const all = z2m.adopt(devices, z2mDiscovery()).devices;
        expect(all[NATIVE]).toBeUndefined();
        expect(Object.keys(all).length).toBeGreaterThan(30);
    });

    it('replace adopts the native one and disables the HA twin (kept, removed by a click)', () => {
        const devices = haFirst();
        const {devices: after} = z2m.adopt(devices, z2mDiscovery(), {keys: [NATIVE], force: true, replace: true});
        expect(after[NATIVE]).toBeDefined();
        expect(after[HA_KEY]?.enabled).toBe(false);
        // a disabled twin covers nothing any more, and the HA side reports no second device
        expect(entry(z2m.diff(z2mDiscovery(), after), NATIVE).twins).toBeUndefined();
        expect(entry(ha.diff(own(), after), HA_KEY).twins).toBeUndefined();
    });

    it('both adopted (forced): each side says so', () => {
        const devices = haFirst();
        const {devices: both} = z2m.adopt(devices, z2mDiscovery(), {keys: [NATIVE], force: true});
        expect(both[HA_KEY]?.enabled).toBeUndefined();
        expect(entry(z2m.diff(z2mDiscovery(), both), NATIVE)).toMatchObject({status: 'unchanged', twins: [HA_KEY]});
        const haEntry = entry(ha.diff(own(), both), HA_KEY);
        expect(haEntry.twins).toEqual([NATIVE]);
        expect(haEntry.notes.join()).toContain('two Matter devices');
    });
});
