import {expect, test} from './fixtures.ts';

// The test stack has no controller, so the fabrics come from a stubbed /api/bridges: the real answer with
// the fabrics an Apple Home pairing leaves (Home and its Keychain companion) and one unknown controller.
const FABRICS = [
    {
        index: 1,
        label: 'Home',
        vendorId: 0x1349,
        vendorName: 'Apple Home',
        nodeId: '1311768467294899695',
        rootNodeId: '1',
        fabricId: '4660',
        compressedFabricId: '0123456789ABCDEF',
        sessions: 1,
        subscriptions: 2,
        lastInteraction: Date.UTC(2026, 9, 27, 10, 0, 0),
    },
    {
        index: 2,
        label: '',
        vendorId: 0x1384,
        vendorName: 'Apple Keychain',
        nodeId: '2',
        rootNodeId: '1',
        fabricId: '4661',
        compressedFabricId: 'FEDCBA9876543210',
        sessions: 0,
        subscriptions: 0,
    },
    {
        index: 3,
        label: 'Lab',
        vendorId: 0x4242,
        nodeId: '3',
        rootNodeId: '1',
        fabricId: '4662',
        compressedFabricId: '00000000000000AA',
        sessions: 0,
        subscriptions: 0,
    },
];

test('the fabrics show the controller by its vendor id, the ids and the sessions', async ({page}) => {
    await page.route('**/api/bridges', async (route) => {
        const response = await route.fetch();
        const bridges = (await response.json()) as Record<string, unknown>[];
        await route.fulfill({response, json: bridges.map((b) => ({...b, commissioned: true, fabrics: FABRICS}))});
    });
    await page.goto('/#/bridges');
    const fabrics = page.getByTestId('fabric');
    await expect(fabrics).toHaveCount(3);

    const home = fabrics.nth(0);
    await expect(home.getByTestId('fabric-controller')).toHaveText('Apple Home');
    await expect(home).toContainText('“Home”');
    await expect(home.getByTestId('fabric-sessions')).toHaveText('sessions: 1 · subscriptions: 2');
    await expect(home.getByTestId('fabric-node-id')).toHaveText('0x1234567890ABCDEF');
    await expect(home).toContainText('0x1349');
    await expect(home).toContainText('0123456789ABCDEF');
    await expect(home.getByTestId('fabric-hint')).toHaveCount(0);

    const keychain = fabrics.nth(1);
    await expect(keychain.getByTestId('fabric-controller')).toHaveText('Apple Keychain');
    await expect(keychain.getByTestId('fabric-sessions')).toHaveText('no active session');
    await expect(keychain.getByTestId('fabric-hint')).toContainText('Apple Home');

    await expect(fabrics.nth(2).getByTestId('fabric-controller')).toHaveText('Unknown controller');
    await expect(fabrics.nth(2)).toContainText('0x4242');
});
