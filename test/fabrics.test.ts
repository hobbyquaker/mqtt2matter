/* The fabrics of the Bridges page from a stubbed fabric and session list: the controller by its root vendor
   id, the ids as the UI shows them, and the sessions counted per fabric. */

import {describe, expect, it} from 'vitest';

import {CONTROLLERS, controllerName, fabricJson, type FabricSource, type SessionSource} from '../src/server/fabrics.ts';

const fabric = (index: number, vendor: number, label = ''): FabricSource => ({
    fabricIndex: index,
    fabricId: 0x1234n + BigInt(index),
    nodeId: 0xabcdef0000000000n + BigInt(index),
    rootNodeId: 1n,
    rootVendorId: vendor,
    globalId: 0x0123456789abcdefn,
    label,
});

describe('the fabrics', () => {
    it('names the controllers by their root vendor id (the CSA ledger ids)', () => {
        expect(controllerName(0x1349)).toBe('Apple Home');
        expect(controllerName(0x1384)).toBe('Apple Keychain');
        expect(controllerName(0x6006)).toBe('Google Home');
        expect(controllerName(0x1217)).toBe('Amazon Alexa');
        expect(controllerName(0x134b)).toBe('Home Assistant');
        expect(controllerName(0x110a)).toBe('Samsung SmartThings');
        expect(controllerName(0xfff1)).toBe('Test vendor');
        expect(controllerName(0x4242)).toBeUndefined();
        expect(new Set(CONTROLLERS.keys()).size).toBe(CONTROLLERS.size);
    });

    it('shows the ids and counts the sessions of each fabric', () => {
        const sessions: SessionSource[] = [
            {
                fabric: {fabricIndex: 1},
                isPeerActive: true,
                lastInteractionTimestamp: 1000,
                numberOfActiveSubscriptions: 2,
            },
            {
                fabric: {fabricIndex: 1},
                isPeerActive: false,
                lastInteractionTimestamp: 3000,
                numberOfActiveSubscriptions: 0,
            },
            {
                fabric: {fabricIndex: 2},
                isPeerActive: true,
                lastInteractionTimestamp: 2000,
                numberOfActiveSubscriptions: 1,
            },
            // a session before CASE has no fabric
            {fabric: undefined, isPeerActive: true, lastInteractionTimestamp: 9000, numberOfActiveSubscriptions: 0},
        ];
        expect(fabricJson(fabric(1, 0x1349, 'Home'), sessions)).toEqual({
            index: 1,
            label: 'Home',
            vendorId: 0x1349,
            vendorName: 'Apple Home',
            nodeId: String(0xabcdef0000000001n),
            rootNodeId: '1',
            fabricId: String(0x1235n),
            compressedFabricId: '0123456789ABCDEF',
            sessions: 1,
            subscriptions: 2,
            lastInteraction: 3000,
        });
        const keychain = fabricJson(fabric(2, 0x1384), sessions);
        expect(keychain).toMatchObject({
            vendorName: 'Apple Keychain',
            sessions: 1,
            subscriptions: 1,
            lastInteraction: 2000,
        });
        const unknown = fabricJson(fabric(3, 0x4242, 'Lab'), sessions);
        expect(unknown).toMatchObject({
            vendorName: undefined,
            sessions: 0,
            subscriptions: 0,
            lastInteraction: undefined,
        });
        // JSON keeps no bigint
        expect(() => JSON.stringify(unknown)).not.toThrow();
    });
});
