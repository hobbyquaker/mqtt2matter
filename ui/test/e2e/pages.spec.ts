import {expect, test} from './fixtures.ts';

test('the check page runs the strict dry run over every device', async ({page}) => {
    await page.goto('/#/check');
    await page.getByTestId('run-check').click();
    await expect(page.getByTestId('check-verdict')).toContainText('Every device conforms.');
});

test('the bridges page shows the pairing codes and opens a commissioning window', async ({page}) => {
    await page.goto('/#/bridges');
    const bridge = page.locator('[data-testid=bridge][data-id=default]');
    await expect(bridge).toContainText('not commissioned');
    await expect(bridge.getByTestId('manual-code')).toHaveText('3497-011-2332');
    await expect(bridge.locator('canvas.qr')).toBeVisible();
    await expect(bridge).toContainText('MT:');
    await expect(bridge).toContainText('No controller has paired this bridge yet.');
    // an uncommissioned node advertises with its window open; a commissioned one needs the button
    await expect(bridge).toContainText('Commissioning window');
    const toggle = bridge.locator('[data-testid=open-window], [data-testid=close-window]');
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    await expect(page.getByTestId('notice').last()).toContainText('Commissioning window');
});

test('the MQTT page lists the topic tree, streams messages and publishes', async ({page}) => {
    await page.goto('/#/mqtt');
    await page.getByTestId('topic-filter').fill('stat/b1');
    await expect(page.getByTestId('topic-row')).toHaveCount(1);
    await expect(page.getByTestId('topic-row').first()).toContainText('POWER');
    await page.getByTestId('topic-row').first().click();
    await expect(page.getByTestId('publish-topic')).toHaveValue('stat/b1/RESULT');
    await page.getByTestId('publish-topic').fill('test/from-ui');
    await page.getByTestId('publish-payload').fill('hello');
    await page.getByTestId('publish').click();
    await expect(page.locator('[data-testid=message-row]', {hasText: 'test/from-ui'}).first()).toContainText('hello');
    // the periodic sensor shows up in the rolling log
    await expect(
        page.locator('[data-testid=message-row]', {hasText: 'sensors/outside/temperature'}).first(),
    ).toBeVisible();
});

test('the log page shows the bridge log and filters by level', async ({page}) => {
    await page.goto('/#/log');
    await expect(page.getByTestId('log-row').first()).toBeVisible();
    await page.getByTestId('log-level').selectOption('error');
    await expect(page.locator('[data-testid=log-row].debug')).toHaveCount(0);
});

test('a preset becomes a device', async ({page}) => {
    await page.goto('/#/presets');
    await page.locator('[data-testid=preset][data-id="tasmota/relay"]').click();
    const dialog = page.getByTestId('preset-dialog');
    await dialog.getByTestId('preset-var-topic').fill('sonoff-desk');
    await dialog.getByTestId('preset-var-name').fill('Desk relay');
    await dialog.getByTestId('preset-preview').click();
    await expect(dialog).toContainText('The device validates.');
    await expect(dialog.getByTestId('preset-key')).toHaveValue('desk-relay');
    await dialog.getByTestId('preset-create').click();
    await expect(page.getByTestId('device-editor')).toBeVisible();
    expect(page.url()).toContain('#/devices/desk-relay');
    await expect(page.getByTestId('binding-row').first()).toContainText('stat/sonoff-desk/RESULT');
    await page.getByTestId('editor-back').click();
    const row = page.locator('[data-testid=device-row][data-key=desk-relay]');
    await expect(row).toContainText('preset');
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});

test('the configuration page exports, refuses an environment-owned change and imports', async ({page}) => {
    await page.goto('/#/config');
    await expect(page.getByTestId('settings-json')).toHaveValue(/"bridges"/);
    await expect(page.getByText('Set by the environment')).toContainText('mqtt.url');
    const json = page.getByTestId('settings-json');
    const text = await json.inputValue();
    await json.fill(text.replace(/"url": "[^"]+"/, '"url": "mqtt://elsewhere"'));
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('notice').last()).toContainText('environment');
    await page.getByTestId('import-json').fill(
        JSON.stringify({
            devices: {'imported-plug': {name: 'Imported plug', endpoints: [{deviceTypes: ['OnOffPlugInUnit']}]}},
        }),
    );
    await page.getByTestId('import').click();
    await page.getByTestId('dialog-ok').click();
    await expect(page.getByTestId('notice').last()).toContainText('1 devices imported');
    await page.getByTestId('tab-devices').click();
    const row = page.locator('[data-testid=device-row][data-key=imported-plug]');
    await expect(row).toContainText('Imported plug');
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});
