/* Home Assistant discovery as the source reads it: the abbreviations expanded, `~` substituted, both
   discovery forms, removals by an empty payload, the topic cache loaded, the device identity. */

import {describe, expect, it} from 'vitest';

import {ha} from '../src/importers/index.ts';
import {TopicCache} from '../src/mqtt/topic-cache.ts';

describe('expansion', () => {
    it('expands every abbreviation, in the entity, its device, origin and availability list', () => {
        const expanded = ha.expandEntity({
            '~': 'tele/x',
            stat_t: '~/STATE',
            cmd_t: 'cmnd/x/POWER',
            avty: [{t: '~/LWT', pl_avail: 'Online', pl_not_avail: 'Offline'}],
            avty_mode: 'all',
            val_tpl: '{{ value_json.POWER }}',
            pl_on: 'ON',
            uniq_id: 'x1',
            dev_cla: 'outlet',
            dev: {
                ids: ['x'],
                mf: 'Tasmota',
                mdl: 'Basic',
                sw: '12',
                sa: 'Kitchen',
                cns: [['mac', '02:00:00:00:00:01']],
            },
            o: {name: 'tasmota', sw: '12', url: 'https://example.invalid'},
            unknown_key: 1,
        });
        expect(expanded).toEqual({
            state_topic: 'tele/x/STATE',
            command_topic: 'cmnd/x/POWER',
            availability: [{topic: 'tele/x/LWT', payload_available: 'Online', payload_not_available: 'Offline'}],
            availability_mode: 'all',
            value_template: '{{ value_json.POWER }}',
            payload_on: 'ON',
            unique_id: 'x1',
            device_class: 'outlet',
            device: {
                identifiers: ['x'],
                manufacturer: 'Tasmota',
                model: 'Basic',
                sw_version: '12',
                suggested_area: 'Kitchen',
                connections: [['mac', '02:00:00:00:00:01']],
            },
            origin: {name: 'tasmota', sw_version: '12', support_url: 'https://example.invalid'},
            unknown_key: 1,
        });
    });

    it('substitutes ~ at the start or the end of topics only', () => {
        const expanded = ha.expandEntity({
            '~': 'base',
            stat_t: '~/state',
            cmd_t: 'cmd/~',
            json_attr_t: 'a/~/b',
            name: '~ not a topic',
            availability_topic: '~',
        });
        expect(expanded.state_topic).toBe('base/state');
        expect(expanded.command_topic).toBe('cmd/base');
        expect(expanded.json_attributes_topic).toBe('a/~/b');
        expect(expanded.name).toBe('~ not a topic');
        expect(expanded.availability_topic).toBe('base');
    });

    it('a single availability object becomes a list', () => {
        const expanded = ha.expandEntity({availability: {topic: 'x/avail', value_template: '{{ value_json.s }}'}});
        expect(expanded.availability).toEqual([{topic: 'x/avail', value_template: '{{ value_json.s }}'}]);
    });

    it('the device-based form: components inherit the shared fields they do not set', () => {
        const {components, device, origin} = ha.expandDevicePayload({
            dev: {ids: ['d1'], name: 'Device'},
            o: {name: 'test'},
            avty: [{t: 'd1/online'}],
            stat_t: 'd1/state',
            qos: 1,
            cmps: {
                a: {p: 'sensor', uniq_id: 'd1_a', val_tpl: '{{ value_json.a }}'},
                b: {'~': 'd1', p: 'switch', uniq_id: 'd1_b', stat_t: '~/b', cmd_t: '~/b/set'},
            },
        });
        expect(device).toEqual({identifiers: ['d1'], name: 'Device'});
        expect(origin).toEqual({name: 'test'});
        expect(components.a).toMatchObject({
            platform: 'sensor',
            state_topic: 'd1/state',
            availability: [{topic: 'd1/online'}],
            device: {identifiers: ['d1'], name: 'Device'},
            qos: 1,
        });
        expect(components.b).toMatchObject({platform: 'switch', state_topic: 'd1/b', command_topic: 'd1/b/set'});
    });
});

describe('topics', () => {
    it('parses both topic layouts and nothing else', () => {
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/switch/relay/config')).toEqual({
            component: 'switch',
            objectId: 'relay',
        });
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/sensor/node1/temp/config')).toEqual({
            component: 'sensor',
            nodeId: 'node1',
            objectId: 'temp',
        });
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/device/abc/config')).toEqual({
            component: 'device',
            objectId: 'abc',
        });
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/status')).toBeUndefined();
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/sensor/x/state')).toBeUndefined();
        expect(ha.parseDiscoveryTopic('homeassistant', 'homeassistant/a/b/c/d/config')).toBeUndefined();
        expect(ha.parseDiscoveryTopic('homeassistant', 'other/sensor/x/config')).toBeUndefined();
        expect(ha.parseDiscoveryTopic('hass', 'hass/light/l/config')).toEqual({component: 'light', objectId: 'l'});
    });

    it('the device identity: the first identifier, a lone string, else the first connection', () => {
        expect(ha.deviceIdentity({identifiers: ['a', 'b']})).toBe('a');
        expect(ha.deviceIdentity({identifiers: 'esp01'})).toBe('esp01');
        expect(ha.deviceIdentity({connections: [['mac', '02:00:00:00:00:01']]})).toBe('mac:02:00:00:00:00:01');
        expect(ha.deviceIdentity({identifiers: [], connections: []})).toBeUndefined();
        expect(ha.deviceIdentity(undefined)).toBeUndefined();
        expect(ha.deviceKey('wasser/zähler status')).toBe('ha:wasser_z_hler_status');
        expect(ha.deviceKey('x'.repeat(100))).toMatch(/^ha:x{52}-[0-9a-f]{8}$/);
    });
});

describe('the source', () => {
    const config = (extra: Record<string, unknown> = {}): string =>
        JSON.stringify({stat_t: 'r/state', cmd_t: 'r/set', uniq_id: 'r1', dev: {ids: ['r']}, ...extra});

    it('keeps entities per topic, removes them on an empty payload, and knows what it saw', () => {
        const source = new ha.HaSource();
        expect(source.topics).toEqual(['homeassistant/#']);
        expect(source.seen).toBe(false);
        expect(source.handle('homeassistant/status', 'online')).toBeUndefined();
        expect(source.seen).toBe(false);
        expect(source.handle('homeassistant/switch/r/config', config())).toBe('entity');
        expect(source.seen).toBe(true);
        expect(source.entities.get('homeassistant/switch/r/config')).toMatchObject({
            component: 'switch',
            objectId: 'r',
            config: {state_topic: 'r/state', unique_id: 'r1'},
        });
        expect(source.discover().items.map((i) => i.key)).toEqual(['ha:r']);
        expect(source.handle('homeassistant/switch/r/config', '')).toBe('removed');
        expect(source.entities.size).toBe(0);
        expect(source.discover().items).toEqual([]);
        expect(() => source.handle('homeassistant/switch/r/config', '{not json')).toThrow();
        expect(() => source.handle('homeassistant/switch/r/config', '[1]')).toThrow(/not an object/);
    });

    it('the device-based form: a new payload replaces every component, a platform-only component is removed', () => {
        const source = new ha.HaSource();
        const payload = (cmps: Record<string, unknown>): string =>
            JSON.stringify({dev: {ids: ['d']}, o: {name: 't'}, stat_t: 'd/state', cmps});
        expect(
            source.handle(
                'homeassistant/device/d/config',
                payload({
                    a: {p: 'switch', uniq_id: 'd_a', cmd_t: 'd/a/set', val_tpl: '{{ value_json.a }}'},
                    b: {p: 'sensor', uniq_id: 'd_b', dev_cla: 'temperature', unit_of_meas: '°C'},
                }),
            ),
        ).toBe('device');
        expect([...source.entities.keys()]).toEqual([
            'homeassistant/device/d/config#a',
            'homeassistant/device/d/config#b',
        ]);
        expect(source.entities.get('homeassistant/device/d/config#a')).toMatchObject({
            component: 'switch',
            objectId: 'a',
            config: {state_topic: 'd/state', command_topic: 'd/a/set', device: {identifiers: ['d']}},
        });
        source.handle(
            'homeassistant/device/d/config',
            payload({a: {p: 'switch', uniq_id: 'd_a', cmd_t: 'd/a/set'}, b: {p: 'sensor'}}),
        );
        expect([...source.entities.keys()]).toEqual(['homeassistant/device/d/config#a']);
        source.handle('homeassistant/device/d/config', '');
        expect(source.entities.size).toBe(0);
    });

    it('loads the retained messages of the cache and reports the ones it cannot parse', () => {
        const cache = new TopicCache();
        cache.store('homeassistant/switch/r/config', Buffer.from(config()), true);
        cache.store('homeassistant/switch/broken/config', Buffer.from('{'), true);
        cache.store('homeassistant/status', Buffer.from('online'), true);
        cache.store('zigbee2mqtt/bridge/state', Buffer.from('{}'), true);
        const source = new ha.HaSource();
        expect(source.load(cache)).toEqual(['homeassistant/switch/broken/config']);
        expect(source.entities.size).toBe(1);
        expect(source.seen).toBe(true);
    });

    it('a custom prefix', () => {
        const source = new ha.HaSource('hass');
        expect(source.topics).toEqual(['hass/#']);
        expect(source.handle('homeassistant/switch/r/config', config())).toBeUndefined();
        expect(source.handle('hass/switch/r/config', config())).toBe('entity');
        expect(source.discover().prefix).toBe('hass');
    });
});
