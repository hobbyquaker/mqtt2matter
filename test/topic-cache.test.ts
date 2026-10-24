import {describe, expect, it} from 'vitest';

import {TopicCache, topicMatches} from '../src/mqtt/topic-cache.ts';

describe('topicMatches', () => {
    it.each([
        ['a/b', 'a/b', true],
        ['a/+', 'a/b', true],
        ['a/+', 'a/b/c', false],
        ['a/#', 'a/b/c', true],
        ['a/#', 'a', true],
        ['#', 'anything/at/all', true],
        ['+/b', 'a/b', true],
        ['a/b', 'a/c', false],
    ])('%s vs %s = %s', (filter, topic, expected) => {
        expect(topicMatches(filter, topic)).toBe(expected);
    });
});

describe('TopicCache', () => {
    it('keeps the last payload per topic and matches filters', () => {
        const cache = new TopicCache();
        cache.store('stat/a', Buffer.from('1'), true, 1);
        cache.store('stat/b', Buffer.from('2'), false, 2);
        cache.store('stat/a', Buffer.from('3'), false, 3);
        expect(cache.size).toBe(2);
        expect(cache.get('stat/a')?.payload.toString()).toBe('3');
        expect(cache.get('stat/a')?.retain).toBe(false);
        expect(cache.match('stat/+').map((m) => m.topic)).toEqual(['stat/b', 'stat/a']);
        expect(cache.topics()).toEqual(['stat/b', 'stat/a']);
    });

    it('drops the oldest topic beyond the limit', () => {
        const cache = new TopicCache(2);
        cache.store('a', Buffer.from(''), false);
        cache.store('b', Buffer.from(''), false);
        cache.store('c', Buffer.from(''), false);
        expect(cache.topics()).toEqual(['b', 'c']);
    });
});
