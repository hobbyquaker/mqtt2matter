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
    // time, level and scope stay on one line each instead of being squeezed to one character
    for (const cell of ['ts', 'level-cell', 'scope']) {
        const box = await page.locator(`[data-testid=log-row] td.${cell}`).first().boundingBox();
        expect(box?.height).toBeLessThan(30);
    }
    await page.getByTestId('log-level').selectOption('error');
    await expect(page.locator('[data-testid=log-row].debug')).toHaveCount(0);
});

test('the presets page searches name, vendor, id and description', async ({page}) => {
    await page.goto('/#/presets');
    const cards = page.getByTestId('preset');
    await expect(page.locator('[data-testid=preset][data-id="tasmota/relay"]')).toBeVisible();
    const total = await cards.count();
    expect(total).toBeGreaterThan(10);
    const search = page.getByTestId('preset-search');
    await search.fill('shelly cover');
    await expect(page.locator('[data-testid=preset][data-id="shelly-gen2/cover"]')).toBeVisible();
    await expect(page.locator('[data-testid=preset][data-id="tasmota/relay"]')).toHaveCount(0);
    expect(await cards.count()).toBeLessThan(total);
    await search.fill('no such preset');
    await expect(page.getByTestId('preset-no-match')).toBeVisible();
    await expect(cards).toHaveCount(0);
    await search.fill('');
    await expect(cards).toHaveCount(total);
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
    await expect(page.getByTestId('mapping-row').first()).toContainText('stat/sonoff-desk/RESULT');
    await page.getByTestId('editor-back').click();
    const row = page.locator('[data-testid=device-row][data-key=desk-relay]');
    await expect(row).toContainText('preset');
    await row.getByTestId('delete-device').click();
    await page.getByTestId('dialog-ok').click();
    await expect(row).toHaveCount(0);
});

test('two devices from the same preset with the same values are two devices', async ({page}) => {
    await page.goto('/#/presets');
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
        await page.locator('[data-testid=preset][data-id="mqtt-smarthome/switch"]').click();
        const dialog = page.getByTestId('preset-dialog');
        await dialog.getByTestId('preset-var-instance').fill('fritz');
        await dialog.getByTestId('preset-var-item').fill('outlet/1/state');
        await dialog.getByTestId('preset-preview').click();
        await expect(dialog).toContainText('The device validates.');
        const key = await dialog.getByTestId('preset-key').inputValue();
        expect(key).not.toBe('');
        keys.push(key);
        await dialog.getByTestId('preset-create').click();
        await expect(page.getByTestId('device-editor')).toBeVisible();
        await page.getByTestId('editor-back').click();
        await page.goto('/#/presets');
    }
    // the second suggestion does not collide with the first device
    expect(keys[1]).toBe(`${keys[0]}-2`);
    await page.goto('/#/devices');
    for (const key of keys) {
        const row = page.locator(`[data-testid=device-row][data-key="${key}"]`);
        await expect(row).toBeVisible();
        await row.getByTestId('delete-device').click();
        await page.getByTestId('dialog-ok').click();
        await expect(row).toHaveCount(0);
    }
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
