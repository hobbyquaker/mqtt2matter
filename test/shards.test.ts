import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {ShardMap} from '../src/matter/shards.ts';

describe('ShardMap', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-shards-'));
    });
    afterEach(async () => {
        await rm(dir, {recursive: true, force: true});
    });

    const bridges = [
        {id: 'a', maxDevices: 2},
        {id: 'b', maxDevices: 0},
    ];

    it('fills bridges in order, remembers, persists and reloads', async () => {
        const file = join(dir, 'shards.json');
        const map = await ShardMap.load(file);
        expect(map.assign('d1', bridges)).toEqual({bridgeId: 'a', moved: false});
        expect(map.assign('d2', bridges)).toEqual({bridgeId: 'a', moved: false});
        expect(map.assign('d3', bridges)).toEqual({bridgeId: 'b', moved: false});
        expect(map.assign('d1', bridges)).toEqual({bridgeId: 'a', moved: false});
        await map.save();
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({d1: 'a', d2: 'a', d3: 'b'});

        const reloaded = await ShardMap.load(file);
        expect(reloaded.get('d3')).toBe('b');
        // a remembered assignment stays even when the bridge is full
        expect(
            reloaded.assign('d2', [
                {id: 'a', maxDevices: 1},
                {id: 'b', maxDevices: 0},
            ]),
        ).toEqual({bridgeId: 'a', moved: false});
    });

    it('honours an explicit bridge and reports the move', () => {
        const map = new ShardMap(join(dir, 'shards.json'), {d1: 'a'});
        expect(map.assign('d1', bridges, 'b')).toEqual({bridgeId: 'b', moved: true});
        expect(map.assign('d1', bridges, 'b')).toEqual({bridgeId: 'b', moved: false});
        expect(map.assign('new', bridges, 'a')).toEqual({bridgeId: 'a', moved: false});
        expect(() => map.assign('x', bridges, 'nope')).toThrow(/not configured/);
    });

    it('uses the last bridge when all are full', () => {
        const map = new ShardMap(join(dir, 'shards.json'), {d1: 'a', d2: 'b'});
        expect(
            map.assign('d3', [
                {id: 'a', maxDevices: 1},
                {id: 'b', maxDevices: 1},
            ]),
        ).toEqual({bridgeId: 'b', moved: false});
    });

    it('refuses a corrupt file', async () => {
        const file = join(dir, 'shards.json');
        await (await import('node:fs/promises')).writeFile(file, '[1]');
        await expect(ShardMap.load(file)).rejects.toThrow(/unreadable/);
    });
});
