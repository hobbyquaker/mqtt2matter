import {expect, test} from './fixtures.ts';

const RELAY = 'ha:aa0000000002';
const HUE = 'ha:zigbee2mqtt_0x00124b0000000001';

test('adopt a Home Assistant discovery device with its area; a zigbee2mqtt-published one is marked native', async ({
    page,
}) => {
    await page.goto('/#/adopt');
    const table = page.getByTestId('adopt-table');
    await expect(table).toBeVisible();

    const relay = page.locator(`[data-testid=adopt-row][data-key="${RELAY}"]`);
    await expect(relay).toContainText('Fairy lights');
    await expect(relay).toContainText('HA discovery');
    await expect(relay.getByTestId('adopt-area')).toHaveText('Küche');
    await expect(relay).toHaveAttribute('data-status', 'new');

    // the filter finds the area
    await page.getByPlaceholder('Filter').fill('küche');
    await expect(page.locator('[data-testid=adopt-row]')).toHaveCount(1);
    await page.getByPlaceholder('Filter').fill('');

    // the device zigbee2mqtt announces itself: shown, marked, the native description preferred
    const hue = page.locator(`[data-testid=adopt-row][data-key="${HUE}"]`);
    await expect(hue).toContainText('native: Zigbee2MQTT');
    await hue.getByTestId('show-details').click();
    await expect(page.getByTestId('details-dialog')).toContainText('z2m:0x00124b0000000001');
    await page.getByTestId('details-dialog').getByText('Close').click();

    // the details list what was not mapped
    await relay.getByTestId('show-details').click();
    await expect(page.getByTestId('details-dialog')).toContainText('Küche');
    await expect(page.getByTestId('details-dialog')).toContainText('no device_class');
    await page.getByTestId('details-dialog').getByText('Close').click();

    await relay.getByTestId('adopt').click();
    await expect(relay).toHaveAttribute('data-status', 'unchanged');
    await page.getByTestId('tab-devices').click();
    const row = page.locator(`[data-testid=device-row][data-key="${RELAY}"]`);
    await expect(row).toContainText('Fairy lights');
    await expect(row).toContainText('HA discovery');
    await expect(row).toContainText('ok');

    // clean up
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});
