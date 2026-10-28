import {describe, expect, it} from 'vitest';

import {follows, resolveValues} from './presets.ts';

const variables = {
    instance: {},
    item: {},
    name: {default: '%item%'},
    max: {default: '100'},
    label: {default: ' %instance% / %name% '},
};

describe('the preset dialog values', () => {
    it('knows which variables follow others', () => {
        expect(follows(variables.name)).toBe(true);
        expect(follows(variables.max)).toBe(false);
        expect(follows(variables.item)).toBe(false);
        expect(follows(undefined)).toBe(false);
    });

    it('starts from the defaults and follows what is typed', () => {
        const none = new Set<string>();
        expect(resolveValues(variables, {}, none)).toEqual({instance: '', item: '', name: '', max: '100', label: '/'});
        expect(resolveValues(variables, {item: 'kitchen/light', instance: 'hm'}, none)).toEqual({
            instance: 'hm',
            item: 'kitchen/light',
            name: 'kitchen/light',
            max: '100',
            label: 'hm / kitchen/light',
        });
    });

    it('keeps an edited field and resolves through it', () => {
        const edited = new Set(['name']);
        expect(resolveValues(variables, {item: 'kitchen/light', name: 'Kitchen', max: ''}, edited)).toEqual({
            instance: '',
            item: 'kitchen/light',
            name: 'Kitchen',
            max: '',
            label: '/ Kitchen',
        });
    });

    it('survives a cycle and an unknown reference', () => {
        expect(
            resolveValues({a: {default: '%b%'}, b: {default: '%a% x'}, c: {default: '%nope%'}}, {}, new Set()),
        ).toEqual({
            a: 'x',
            b: 'x',
            c: '',
        });
    });
});

describe('the words modifier', () => {
    it('turns the slashes of a referenced value into spaces', () => {
        const vars = {item: {}, name: {default: '%item|words%'}};
        expect(resolveValues(vars, {item: 'kitchen/ceiling//light'}, new Set()).name).toBe('kitchen ceiling light');
    });
});
