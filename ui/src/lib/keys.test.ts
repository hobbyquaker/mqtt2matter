import {describe, expect, it} from 'vitest';

import {DEVICE_KEY_PATTERN, freeKey, keyFromName} from './keys.ts';

describe('device keys', () => {
    it('suggests a key from a name', () => {
        expect(keyFromName('Desk relay')).toBe('desk-relay');
        expect(keyFromName('  Küche / Licht 2 ')).toBe('k-che-licht-2');
        expect(keyFromName('x'.repeat(80))).toHaveLength(64);
        expect(keyFromName('---')).toBe('');
        expect(keyFromName('tasmota.relay 1')).toBe('tasmota-relay-1');
        expect(DEVICE_KEY_PATTERN.test('tasmota.relay')).toBe(false);
        expect(DEVICE_KEY_PATTERN.test(keyFromName('Desk relay'))).toBe(true);
    });

    it('takes the first free key', () => {
        expect(freeKey('switch', [])).toBe('switch');
        expect(freeKey('switch', ['switch'])).toBe('switch-2');
        expect(freeKey('switch', ['switch', 'switch-2', 'switch-3'])).toBe('switch-4');
        expect(freeKey('switch', ['switch-2'])).toBe('switch');
        expect(freeKey('', ['x'])).toBe('');
        const long = 'x'.repeat(64);
        const suffixed = freeKey(long, [long]);
        expect(suffixed).toBe(`${'x'.repeat(62)}-2`);
        expect(DEVICE_KEY_PATTERN.test(suffixed)).toBe(true);
    });
});
