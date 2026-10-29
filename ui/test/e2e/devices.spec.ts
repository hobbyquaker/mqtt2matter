import {expect, test} from './fixtures.ts';

test('the device list shows source, bridge, endpoint number and state', async ({page}) => {
    await page.goto('/#/devices');
    const lamp = page.locator('[data-testid=device-row][data-key=living-room-lamp]');
    await expect(lamp).toContainText('Living room lamp');
    await expect(lamp).toContainText('ColorTemperatureLight');
    await expect(lamp).toContainText('manual');
    await expect(lamp).toContainText('default');
    await expect(lamp.locator('td').nth(5)).toHaveText(/^\d+$/);
    await expect(lamp).toContainText('ok');
    await expect(lamp.locator('.ui-dot-ok')).toBeVisible();
    const blind = page.locator('[data-testid=device-row][data-key=office-blind]');
    await expect(blind).toContainText('disabled');
});

test('create a device by hand, bind a suggested attribute with the topic picker, save, check, delete', async ({
    page,
}) => {
    await page.goto('/#/devices');
    await page.getByTestId('new-device').click();
    const dialog = page.getByTestId('create-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('new-name').fill('Desk plug');
    await dialog.getByTestId('new-name').blur();
    await expect(dialog.getByTestId('new-key')).toHaveValue('desk-plug');
    await dialog.getByTestId('new-type').selectOption('OnOffPlugInUnit');
    await dialog.getByTestId('create-device').click();

    // the editor opens with the mandatory cluster suggested
    const editor = page.getByTestId('device-editor');
    await expect(editor).toBeVisible();
    expect(page.url()).toContain('#/devices/desk-plug');
    await expect(editor.getByTestId('device-type-chip')).toHaveText(['OnOffPlugInUnit']);
    const suggestion = editor.locator('[data-testid=bind-suggestion][data-target="OnOff.onOff"]');
    await expect(suggestion).toBeVisible();
    await expect(editor.getByTestId('suggestion-row').first()).toContainText('mandatory');
    await suggestion.click();

    // the mapping editor: the status topic from the live topic tree, the key from the payload
    const mapping = page.getByTestId('mapping-editor');
    await expect(mapping).toBeVisible();
    await expect(mapping.getByTestId('mapping-cluster')).toHaveValue('OnOff');
    await expect(mapping.getByTestId('mapping-member')).toHaveValue('onOff');
    await mapping.getByTestId('status-enabled').check();
    await mapping.getByTestId('pick-status-topic').click();
    const picker = page.getByTestId('topic-picker');
    await picker.getByTestId('picker-filter').fill('stat/b1');
    await picker.getByTestId('picker-row').first().click();
    await picker.locator('[data-testid=picker-path]', {hasText: '$.POWER'}).click();
    await expect(mapping.getByTestId('status-topic')).toHaveValue('stat/b1/RESULT');
    await expect(mapping.getByTestId('status-extract')).toHaveValue('$.POWER');
    await mapping.getByTestId('map-add').click();
    await mapping.getByTestId('map-key').last().fill('ON');
    await mapping.getByTestId('map-value').last().fill('true');
    await mapping.getByTestId('map-add').click();
    await mapping.getByTestId('map-key').last().fill('OFF');
    await mapping.getByTestId('map-value').last().fill('false');
    // the live preview: the retained payload through extract and map
    await expect(mapping.getByTestId('status-payload')).toHaveValue(/POWER/);
    await expect(mapping.getByTestId('status-stages')).toContainText('extract');
    await expect(mapping.getByTestId('status-stages')).toContainText('attribute');
    await expect(mapping.getByTestId('status-stages').locator('li').last()).toContainText('true');
    // the command half with a format and the reverse preview
    await mapping.getByTestId('command-enabled').check();
    await mapping.getByTestId('command-topic').fill('cmnd/desk/POWER');
    await mapping.getByText('ON / OFF').click();
    await mapping.getByTestId('command-value').selectOption('true');
    await expect(mapping.getByTestId('command-stages').locator('li').last()).toContainText('ON');
    await mapping.getByTestId('mapping-save').click();

    await expect(editor.getByTestId('mapping-row')).toHaveCount(1);
    await expect(editor.getByTestId('mapping-row').first()).toContainText('OnOff.onOff');
    await expect(editor.getByTestId('issues')).toHaveCount(0);
    await editor.getByTestId('save-device').click();
    await expect(page.getByTestId('notice').last()).toContainText('saved and built');
    await expect(editor.locator('.ui-badge-ok')).toContainText('endpoint');

    // the strict dry run from the editor
    await editor.getByTestId('check-device').click();
    await expect(editor.getByText('matter.js builds the device without complaint.')).toBeVisible();

    // the JSON view shows the compact device
    await editor.getByTestId('view-json').click();
    await expect(editor.getByTestId('device-json')).toHaveValue(/"attribute": "OnOff.onOff"/);

    // back to the list: the device is there and built; delete it through the shell's dialog
    await editor.getByTestId('editor-back').click();
    const row = page.locator('[data-testid=device-row][data-key=desk-plug]');
    await expect(row).toContainText('Desk plug');
    await expect(row).toContainText('ok');
    await row.getByTestId('delete-device').click();
    await expect(page.getByTestId('dialog-confirm')).toContainText('Desk plug');
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});

test('editing a device validates live and refuses an unsaved exit without asking', async ({page}) => {
    await page.goto('/#/devices/living-room-lamp');
    const editor = page.getByTestId('device-editor');
    await expect(editor.getByTestId('mapping-row')).toHaveCount(3);
    await expect(editor.getByText('The device validates.')).toBeVisible();
    await editor.getByTestId('device-name').fill('');
    await expect(editor.getByTestId('issues')).toContainText('name');
    await editor.getByTestId('device-name').fill('Living room lamp');
    await editor.getByTestId('remove-mapping').first().click();
    await expect(editor.getByTestId('mapping-row')).toHaveCount(2);
    await editor.getByTestId('editor-back').click();
    await expect(page.getByTestId('dialog-confirm')).toContainText('Discard');
    await page.getByTestId('dialog-ok').click();
    await expect(page.getByTestId('devices-page')).toBeVisible();
    // nothing was saved
    await page.goto('/#/devices/living-room-lamp');
    await expect(editor.getByTestId('mapping-row')).toHaveCount(3);
});

test('the editor scrolls a device taller than the page instead of squeezing its sections', async ({page}) => {
    await page.setViewportSize({width: 1280, height: 420});
    await page.goto('/#/devices/living-room-lamp');
    const editor = page.getByTestId('device-editor');
    await expect(editor.getByTestId('mapping-row')).toHaveCount(3);
    // the page's blocks (the device and availability pair, the endpoints) keep their content height
    const squeezed = await editor
        .locator('.ui-page-scroll > *')
        .evaluateAll((blocks) => blocks.filter((b) => b.scrollHeight > b.clientHeight + 1).length);
    expect(squeezed).toBe(0);
});

test('a copy of a device gets a free key, a taken key is refused', async ({page}) => {
    await page.goto('/#/devices');
    const keys = ['living-room-lamp-copy', 'living-room-lamp-copy-2'];
    for (const key of keys) {
        await page
            .locator('[data-testid=device-row][data-key=living-room-lamp]')
            .getByTestId('duplicate-device')
            .click();
        const prompt = page.getByTestId('dialog-prompt');
        await expect(prompt.getByTestId('dialog-input')).toHaveValue(key);
        // a key that exists is named and refused
        await prompt.getByTestId('dialog-input').fill('living-room-lamp');
        await expect(prompt.getByTestId('dialog-problem')).toContainText('exists already');
        await expect(prompt.getByTestId('dialog-ok')).toBeDisabled();
        await prompt.getByTestId('dialog-input').fill(key);
        await expect(prompt.getByTestId('dialog-problem')).toHaveCount(0);
        await prompt.getByTestId('dialog-ok').click();
        await expect(page.getByTestId('device-editor')).toBeVisible();
        expect(page.url()).toContain(`#/devices/${key}`);
        await page.getByTestId('editor-back').click();
    }
    // the create dialog suggests a free key too and refuses a taken one
    await page.getByTestId('new-device').click();
    const dialog = page.getByTestId('create-dialog');
    await dialog.getByTestId('new-name').fill('Living room lamp');
    await dialog.getByTestId('new-name').blur();
    await expect(dialog.getByTestId('new-key')).toHaveValue('living-room-lamp-2');
    await dialog.getByTestId('new-key').fill('living-room-lamp');
    await expect(dialog.getByTestId('new-key-help')).toContainText('exists already');
    await expect(dialog.getByTestId('create-device')).toBeDisabled();
    await page.keyboard.press('Escape');
    for (const key of keys) {
        const row = page.locator(`[data-testid=device-row][data-key=${key}]`);
        await row.getByTestId('delete-device').click();
        await page.getByTestId('dialog-ok').click();
        await expect(row).toHaveCount(0);
    }
});
