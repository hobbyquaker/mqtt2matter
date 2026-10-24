/* The area table against matter.js: every tag id the importer writes is the one `CommonAreaNamespaceTag`
   carries, and the names resolve in English and German. */

import {CommonAreaNamespaceTag} from '@matter/main';
import {describe, expect, it} from 'vitest';

import {ha} from '../src/importers/index.ts';

describe('the Common Area tags', () => {
    it('match matter.js, name by name and id by id', () => {
        const library = CommonAreaNamespaceTag as unknown as Record<string, {tag: number; namespaceId: number}>;
        for (const [name, id] of Object.entries(ha.AREA_TAGS)) {
            const tag = library[name];
            expect(tag, name).toBeDefined();
            expect(tag?.tag, name).toBe(id);
            expect(tag?.namespaceId, name).toBe(16);
        }
        const names = Object.keys(library).filter((k) => typeof library[k] === 'object' && !k.startsWith('Reserved'));
        expect(names.filter((n) => !(n in ha.AREA_TAGS))).toEqual([]);
    });

    it('resolves names in English and German, ignoring case, spaces and umlauts', () => {
        expect(ha.areaTag('Kitchen')).toEqual({name: 'Kitchen', id: 47});
        expect(ha.areaTag('living room')).toEqual({name: 'LivingRoom', id: 52});
        expect(ha.areaTag('Küche')).toEqual({name: 'Kitchen', id: 47});
        expect(ha.areaTag('Wohnzimmer')).toEqual({name: 'LivingRoom', id: 52});
        expect(ha.areaTag('Schlafzimmer')).toEqual({name: 'Bedroom', id: 7});
        expect(ha.areaTag('Gäste-WC')).toEqual({name: 'Toilet', id: 95});
        expect(ha.areaTag('Hobbyraum')).toEqual({name: 'CraftRoom', id: 17});
        expect(ha.areaTag('Greenhouse')).toBeUndefined();
        expect(ha.areaTag('')).toBeUndefined();
    });
});
