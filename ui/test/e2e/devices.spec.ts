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

    // the binding editor: the status topic from the live topic tree, the key from the payload
    const binding = page.getByTestId('binding-editor');
    await expect(binding).toBeVisible();
    await expect(binding.getByTestId('binding-cluster')).toHaveValue('OnOff');
    await expect(binding.getByTestId('binding-member')).toHaveValue('onOff');
    await binding.getByTestId('status-enabled').check();
    await binding.getByTestId('pick-status-topic').click();
    const picker = page.getByTestId('topic-picker');
    await picker.getByTestId('picker-filter').fill('stat/b1');
    await picker.getByTestId('picker-row').first().click();
    await picker.locator('[data-testid=picker-path]', {hasText: '$.POWER'}).click();
    await expect(binding.getByTestId('status-topic')).toHaveValue('stat/b1/RESULT');
    await expect(binding.getByTestId('status-extract')).toHaveValue('$.POWER');
    await binding.getByTestId('map-add').click();
    await binding.getByTestId('map-key').last().fill('ON');
    await binding.getByTestId('map-value').last().fill('true');
    await binding.getByTestId('map-add').click();
    await binding.getByTestId('map-key').last().fill('OFF');
    await binding.getByTestId('map-value').last().fill('false');
    // the live preview: the retained payload through extract and map
    await expect(binding.getByTestId('status-payload')).toHaveValue(/POWER/);
    await expect(binding.getByTestId('status-stages')).toContainText('extract');
    await expect(binding.getByTestId('status-stages')).toContainText('attribute');
    await expect(binding.getByTestId('status-stages').locator('li').last()).toContainText('true');
    // the command half with a format and the reverse preview
    await binding.getByTestId('command-enabled').check();
    await binding.getByTestId('command-topic').fill('cmnd/desk/POWER');
    await binding.getByText('ON / OFF').click();
    await binding.getByTestId('command-value').selectOption('true');
    await expect(binding.getByTestId('command-stages').locator('li').last()).toContainText('ON');
    await binding.getByTestId('binding-save').click();

    await expect(editor.getByTestId('binding-row')).toHaveCount(1);
    await expect(editor.getByTestId('binding-row').first()).toContainText('OnOff.onOff');
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
    await expect(editor.getByTestId('binding-row')).toHaveCount(3);
    await expect(editor.getByText('The device validates.')).toBeVisible();
    await editor.getByTestId('device-name').fill('');
    await expect(editor.getByTestId('issues')).toContainText('name');
    await editor.getByTestId('device-name').fill('Living room lamp');
    await editor.getByTestId('remove-binding').first().click();
    await expect(editor.getByTestId('binding-row')).toHaveCount(2);
    await editor.getByTestId('editor-back').click();
    await expect(page.getByTestId('dialog-confirm')).toContainText('Discard');
    await page.getByTestId('dialog-ok').click();
    await expect(page.getByTestId('devices-page')).toBeVisible();
    // nothing was saved
    await page.goto('/#/devices/living-room-lamp');
    await expect(editor.getByTestId('binding-row')).toHaveCount(3);
});
