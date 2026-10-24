import {expect, test} from './fixtures.ts';

const LIGHT = 'z2m:0xa4c138071003495f';

test('adopt a zigbee2mqtt device, see it built, and remove the orphan by a click', async ({page}) => {
    await page.goto('/#/adopt');
    const table = page.getByTestId('adopt-table');
    await expect(table).toBeVisible();
    const light = page.locator(`[data-testid=adopt-row][data-key="${LIGHT}"]`);
    await expect(light).toContainText('Gledopto RGBCTT light I');
    await expect(light).toHaveAttribute('data-status', 'new');
    // unsupported entries are hidden until asked for
    await expect(page.locator('[data-testid=adopt-row][data-status=unsupported]')).toHaveCount(0);
    await page.getByText('show unsupported').click();
    expect(await page.locator('[data-testid=adopt-row][data-status=unsupported]').count()).toBeGreaterThan(0);

    // the details of an entry
    await light.getByTestId('show-details').click();
    await expect(page.getByTestId('details-dialog')).toContainText('linkquality');
    await page.getByTestId('details-dialog').getByText('Close').click();

    await light.getByTestId('adopt').click();
    await expect(light).toHaveAttribute('data-status', 'unchanged');
    await page.getByTestId('tab-devices').click();
    const row = page.locator(`[data-testid=device-row][data-key="${LIGHT}"]`);
    await expect(row).toContainText('Gledopto RGBCTT light I');
    await expect(row).toContainText('Zigbee2MQTT');
    await expect(row).toContainText('ok');

    // the orphan from the configuration: never removed by itself, deleted by the click
    await page.getByTestId('tab-adopt').click();
    const orphan = page.locator('[data-testid=adopt-row][data-status=orphaned]');
    await expect(orphan).toContainText('Hall window');
    await orphan.getByTestId('remove-orphan').click();
    await expect(page.getByTestId('dialog-confirm')).toContainText('Hall window');
    await page.getByTestId('dialog-ok').click();
    await expect(orphan).toHaveCount(0);

    // clean up: the adopted light goes too
    await page.getByTestId('tab-devices').click();
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});
