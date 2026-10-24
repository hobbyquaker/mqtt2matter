/* Baseline + patch: edits keyed by endpoint id and binding target survive a regenerated baseline;
   edits on what the baseline changed too are conflicts, reported and still applied. */

import {describe, expect, it} from 'vitest';

import {applyOps, diffTrees, editsOf, fromTree, resync, toTree} from '../src/importers/patch.ts';
import type {DeviceInput} from '../src/model/schema.ts';

const baseline = (): DeviceInput => ({
    name: 'Lamp',
    vendor: 'Acme',
    source: {kind: 'z2m', key: '0x1', version: '1'},
    availability: {topic: 'z/lamp/availability', extract: 'state'},
    endpoints: [
        {
            deviceTypes: ['DimmableLight'],
            coalesce: 50,
            bindings: [
                {
                    attribute: 'OnOff.onOff',
                    status: {topic: 'z/lamp', extract: 'state', map: {ON: true, OFF: false}},
                    command: {topic: 'z/lamp/set', wrap: 'state', format: {true: 'ON', false: 'OFF'}},
                },
                {
                    attribute: 'LevelControl.currentLevel',
                    status: {topic: 'z/lamp', extract: 'brightness', unit: 'byteLevel'},
                    command: {topic: 'z/lamp/set', wrap: 'brightness', unit: 'byteLevel', round: 0},
                },
            ],
        },
        {
            id: 'l2',
            deviceTypes: ['OnOffLight'],
            bindings: [{attribute: 'OnOff.onOff', status: {topic: 'z/lamp', extract: 'state_l2'}}],
        },
    ],
});

describe('the keyed tree', () => {
    it('round-trips a device, source left out', () => {
        const device = baseline();
        const tree = toTree(device);
        expect(tree.source).toBeUndefined();
        expect(Object.keys(tree.endpoints as object)).toEqual(['main', 'l2']);
        const main = (tree.endpoints as Record<string, Record<string, unknown>>).main!;
        expect(Object.keys(main.bindings as object)).toEqual([
            'attribute:OnOff.onOff',
            'attribute:LevelControl.currentLevel',
        ]);
        const expected: Partial<DeviceInput> = structuredClone(device);
        delete expected.source;
        expect(fromTree(tree)).toEqual(expected);
    });

    it('keys a repeated target with a counter', () => {
        const tree = toTree({
            name: 'x',
            endpoints: [
                {
                    deviceTypes: ['OnOffLight'],
                    bindings: [
                        {attribute: 'OnOff.onOff', status: {topic: 'a'}},
                        {attribute: 'OnOff.onOff', status: {topic: 'b'}},
                        {invoke: 'Identify.identify', command: {topic: 'c', payload: 'x'}},
                        {event: 'Switch', status: {topic: 'd'}},
                    ],
                },
            ],
        });
        const main = (tree.endpoints as Record<string, Record<string, unknown>>).main!;
        expect(Object.keys(main.bindings as object)).toEqual([
            'attribute:OnOff.onOff',
            'attribute:OnOff.onOff#2',
            'invoke:Identify.identify',
            'event:Switch',
        ]);
    });
});

describe('diff and apply', () => {
    it('finds sets and deletes down to the leaves', () => {
        const ops = diffTrees({a: 1, b: {c: 2, d: 3}, e: [1, 2]}, {a: 1, b: {c: 5}, e: [1, 3], f: 'new'});
        expect(ops).toEqual([
            {op: 'delete', path: ['b', 'd']},
            {op: 'set', path: ['b', 'c'], value: 5},
            {op: 'set', path: ['e'], value: [1, 3]},
            {op: 'set', path: ['f'], value: 'new'},
        ]);
    });

    it('applies edits on untouched paths without conflict, reports the rest', () => {
        const oldBase = {name: 'Old', t: {x: 1, y: 2}, gone: {z: 1}};
        const newBase = {name: 'New', t: {x: 10, y: 2}};
        const ops = diffTrees(oldBase, {name: 'Mine', t: {x: 1, y: 20}, gone: {z: 5}, added: true});
        const {tree, conflicts} = applyOps(ops, oldBase, newBase);
        // the name: baseline changed and the user changed it — conflict, the edit wins
        expect(tree.name).toBe('Mine');
        // y: only the user changed it — applied, no conflict; x: only the baseline changed — taken over
        expect(tree.t).toEqual({x: 10, y: 20});
        // gone.z: the parent disappeared — not applied
        expect(tree.gone).toBeUndefined();
        expect(tree.added).toBe(true);
        expect(conflicts.map((c) => [c.path, c.applied])).toEqual([
            ['name', true],
            ['gone.z', false],
        ]);
        expect(conflicts[0]).toMatchObject({user: 'Mine', before: 'Old', now: 'New'});
    });

    it('a delete of what the baseline changed stays a delete, not a conflict', () => {
        const oldBase = {a: {b: 1}};
        const newBase = {a: {b: 2}};
        const {tree, conflicts} = applyOps([{op: 'delete', path: ['a', 'b']}], oldBase, newBase);
        expect(tree).toEqual({a: {}});
        expect(conflicts).toEqual([]);
    });
});

describe('resync', () => {
    it('carries edits over a renamed baseline and keeps the baseline order', () => {
        const old = baseline();
        const current = baseline();
        // the user's edits: a different on/off payload, a dropped level binding, an extra binding, a new endpoint
        current.endpoints[0]!.bindings![0]!.command!.format = {true: 'on', false: 'off'};
        current.endpoints[0]!.bindings!.splice(1, 1);
        current.endpoints[0]!.bindings!.push({
            invoke: 'Identify.identify',
            command: {topic: 'z/lamp/set', payload: 'id'},
        });
        current.endpoints.push({id: 'mine', deviceTypes: ['ContactSensor'], bindings: []});
        current.name = 'My lamp';
        current.source = {kind: 'z2m', key: '0x1', version: '1', orphaned: true};

        // zigbee2mqtt renamed the device: every topic changes, the name too
        const renamed = JSON.parse(JSON.stringify(baseline()).replaceAll('z/lamp', 'z/kitchen')) as DeviceInput;
        renamed.name = 'Kitchen';
        renamed.source = {kind: 'z2m', key: '0x1', version: '2'};

        const result = resync(old, current, renamed);
        const main = result.device.endpoints[0]!;
        expect(
            main.bindings!.map((b) => ('attribute' in b ? b.attribute : 'invoke' in b ? b.invoke : b.event)),
        ).toEqual(['OnOff.onOff', 'Identify.identify']);
        expect(main.bindings![0]!.command).toEqual({
            topic: 'z/kitchen/set',
            wrap: 'state',
            format: {true: 'on', false: 'off'},
        });
        expect(result.device.endpoints.map((e) => e.id ?? 'main')).toEqual(['main', 'l2', 'mine']);
        expect(result.device.availability).toEqual({topic: 'z/kitchen/availability', extract: 'state'});
        // the name was edited and the baseline renamed: the edit wins, the conflict says what zigbee2mqtt calls it
        expect(result.device.name).toBe('My lamp');
        expect(result.conflicts).toEqual([
            expect.objectContaining({path: 'name', user: 'My lamp', before: 'Lamp', now: 'Kitchen', applied: true}),
        ]);
        // the source stays the caller's business
        expect(result.device.source).toEqual(current.source);
        expect(result.edits.length).toBeGreaterThan(0);
    });

    it('an untouched device has no edits', () => {
        expect(editsOf(baseline(), baseline())).toEqual([]);
    });
});
