import {expect, test} from './fixtures.ts';

const RELAY = 'ha:aa0000000002';
const HUE = 'ha:zigbee2mqtt_0x00124b0000000001';

test('adopt a Home Assistant discovery device with its area; a zigbee2mqtt-published one is a duplicate that asks first', async ({
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

    // it is a duplicate: "Adopt all new" leaves it, the single button asks first
    await expect(hue).toHaveAttribute('data-status', 'covered');
    await expect(hue).toContainText('duplicate');
    await hue.getByTestId('adopt').click();
    await expect(page.getByText('makes a second Matter device')).toBeVisible();
    await page.getByRole('button', {name: 'Cancel'}).click();
    await expect(page.getByText('makes a second Matter device')).toHaveCount(0);
    await expect(hue).toHaveAttribute('data-status', 'covered');
    await hue.getByTestId('adopt').click();
    await page.getByTestId('dialog-ok').click();
    await expect(hue).toHaveAttribute('data-status', 'unchanged');
    await page.getByTestId('tab-devices').click();
    const hueRow = page.locator(`[data-testid=device-row][data-key="${HUE}"]`);
    await hueRow.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(hueRow).toHaveCount(0);
    await page.getByTestId('tab-adopt').click();

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

test('a binary sensor announced without a class: choose its sensor type, adopt, and the choice is kept', async ({
    page,
}) => {
    const CAMERA = 'ha:cam00001';
    await page.goto('/#/adopt');
    const camera = page.locator(`[data-testid=adopt-row][data-key="${CAMERA}"]`);
    // unsupported, but shown without "show unsupported": a type would make it adoptable
    await expect(camera).toHaveAttribute('data-status', 'unsupported');
    await expect(camera.getByTestId('untyped')).toHaveText('2 without a type');

    await camera.getByTestId('choose-types').click();
    const dialog = page.getByTestId('details-dialog');
    await expect(dialog).toContainText('Sensor types');
    await expect(dialog.getByTestId('details-adopt')).toBeDisabled();
    await dialog.locator('[data-testid=sensor-type][data-entity=MotionSensor]').selectOption('motion');
    await expect(dialog.locator('[data-testid=sensor-type][data-entity=Online]')).toHaveValue('');
    await dialog.getByTestId('details-adopt').click();
    await expect(dialog).toHaveCount(0);
    await expect(camera).toHaveAttribute('data-status', 'unchanged');
    await expect(camera.getByTestId('untyped')).toHaveText('1 without a type');

    // the choice is shown again and survives a re-sync
    await page.getByTestId('resync').click();
    await page.getByTestId('dialog-ok').click();
    await expect(camera).toHaveAttribute('data-status', 'unchanged');
    await camera.getByTestId('show-details').click();
    await expect(dialog.locator('[data-testid=sensor-type][data-entity=MotionSensor]')).toHaveValue('motion');
    await expect(dialog.getByTestId('details-apply')).toBeDisabled();
    await dialog.getByText('Close').click();

    await page.getByTestId('tab-devices').click();
    const row = page.locator(`[data-testid=device-row][data-key="${CAMERA}"]`);
    await expect(row).toContainText('Staircase');
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});
