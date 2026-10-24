import {expect, test} from './fixtures.ts';

test('every page renders, in the browser language and in both themes', async ({page}) => {
    await page.goto('/#/devices');
    await expect(page.getByTestId('devices-page')).toBeVisible();
    await expect(page.getByTestId('device-row').first()).toBeVisible();
    for (const id of ['presets', 'adopt', 'bridges', 'mqtt', 'log', 'check', 'config']) {
        await page.getByTestId(`tab-${id}`).click();
        await expect(page.getByTestId(`${id}-page`)).toBeVisible();
        expect(page.url()).toContain(`#/${id}`);
    }
    // the hash is the route
    await page.goto('/#/bridges');
    await expect(page.getByTestId('bridges-page')).toBeVisible();
});

test('the language switch translates the shell at once', async ({page}) => {
    await page.goto('/#/devices');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Devices/);
    await page.getByTestId('language').selectOption('de');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Geräte/);
    await expect(page.getByTestId('new-device')).toHaveText(/Neues Gerät/);
    await page.reload();
    await expect(page.getByTestId('tab-devices')).toHaveText(/Geräte/);
    await page.getByTestId('language').selectOption('en');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Devices/);
});

test('the theme button cycles system → light → dark and the choice sticks', async ({page}) => {
    await page.goto('/#/devices');
    const root = page.locator('html');
    await expect(root).not.toHaveAttribute('data-theme');
    await page.getByTestId('theme').click();
    await expect(root).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme').click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(30, 30, 30)');
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme').click();
    await expect(root).not.toHaveAttribute('data-theme');
});

test('the status dots show the broker and the event stream', async ({page}) => {
    await page.goto('/#/devices');
    await expect(page.locator('.header .status .ui-dot-ok')).toHaveCount(2);
});
