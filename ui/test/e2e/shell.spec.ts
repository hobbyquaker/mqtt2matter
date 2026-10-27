import {expect, test} from './fixtures.ts';

test('every page renders, in the browser language and in both themes', async ({page}) => {
    await page.goto('/#/devices');
    await expect(page.getByTestId('devices-page')).toBeVisible();
    await expect(page.getByTestId('device-row').first()).toBeVisible();
    for (const id of ['presets', 'adopt', 'bridges', 'mqtt', 'log', 'check']) {
        await page.getByTestId(`tab-${id}`).click();
        await expect(page.getByTestId(`${id}-page`)).toBeVisible();
        expect(page.url()).toContain(`#/${id}`);
    }
    // the configuration is behind the gear, not a tab
    await expect(page.getByTestId('tab-config')).toHaveCount(0);
    await page.getByTestId('config-button').click();
    await expect(page.getByTestId('config-page')).toBeVisible();
    expect(page.url()).toContain('#/config');
    await expect(page.getByTestId('config-button')).toHaveAttribute('aria-current', 'page');
    // the hash is the route
    await page.goto('/#/bridges');
    await expect(page.getByTestId('bridges-page')).toBeVisible();
});

test('the language switch on the configuration page translates the shell at once', async ({page}) => {
    await page.goto('/#/config');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Devices/);
    await page.getByTestId('language').selectOption('de');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Geräte/);
    await expect(page.getByTestId('display')).toContainText('Anzeige');
    await page.reload();
    await expect(page.getByTestId('tab-devices')).toHaveText(/Geräte/);
    await page.getByTestId('language').selectOption('en');
    await expect(page.getByTestId('tab-devices')).toHaveText(/Devices/);
});

test('the theme switch on the configuration page: system, light, dark, and the choice sticks', async ({page}) => {
    await page.goto('/#/config');
    const root = page.locator('html');
    await expect(root).not.toHaveAttribute('data-theme');
    await page.getByTestId('theme').selectOption('light');
    await expect(root).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme').selectOption('dark');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(30, 30, 30)');
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('theme')).toHaveValue('dark');
    await page.getByTestId('theme').selectOption('system');
    await expect(root).not.toHaveAttribute('data-theme');
});

test('the status dots show the broker and the event stream', async ({page}) => {
    await page.goto('/#/devices');
    await expect(page.locator('.header .status .ui-dot-ok')).toHaveCount(2);
});

test('the GitHub icon links to the repository in a new tab', async ({page}) => {
    await page.goto('/#/devices');
    const link = page.getByTestId('github');
    await expect(link).toHaveAttribute('href', 'https://github.com/hobbyquaker/mqtt2matter');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
});

test('the statistics popup shows the process figures and the counts, and closes outside', async ({page}) => {
    await page.goto('/#/devices');
    await page.getByTestId('stats-button').click();
    const stats = page.getByTestId('stats');
    await expect(stats).toBeVisible();
    // the stack is shared with the other specs, which add devices: the count is the Devices tab's
    const count = (await page.getByTestId('tab-devices').locator('.ui-tab-badge').textContent()) ?? '';
    await expect(stats.getByTestId('stats-devices')).toHaveText(count);
    await expect(stats.getByTestId('stats-endpoints')).toHaveText(/^\d+$/);
    await expect(stats.getByTestId('stats-bridges')).toContainText('0 / 1');
    await expect(stats.getByTestId('stats-memory')).toHaveText(/^\d+ MB$/);
    await expect(stats.getByTestId('stats-cpu')).toHaveText(/^[\d.]+ %$/);
    await expect(stats.getByTestId('stats-elu')).toHaveText(/^\d+ %$/);
    await expect(stats.getByTestId('stats-lag-mean')).toHaveText(/^[\d.]+ ms$/);
    await expect(stats.getByTestId('stats-lag-max')).toHaveText(/^[\d.]+ ms$/);
    await expect(stats.getByTestId('stats-uptime')).toHaveText(/\d+m$/);
    expect(Number(await stats.getByTestId('stats-topics').textContent())).toBeGreaterThan(0);
    // one popup at a time; a click outside or ESC closes it
    await page.getByTestId('version-button').click();
    await expect(stats).toHaveCount(0);
    await expect(page.getByTestId('version')).toBeVisible();
    await page.getByTestId('devices-page').click({position: {x: 5, y: 5}});
    await expect(page.getByTestId('version')).toHaveCount(0);
    await page.getByTestId('stats-button').click();
    await expect(stats).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(stats).toHaveCount(0);
});

test('§ opens the licences: our own Apache-2.0 and the third-party packages', async ({page}) => {
    await page.goto('/#/devices');
    await page.getByTestId('licenses-button').click();
    const dialog = page.getByTestId('licenses');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('licenses-self-license')).toHaveText('Apache-2.0');
    const runtime = dialog.getByTestId('licenses-runtime');
    const matter = runtime.getByTestId('license-package').filter({hasText: '@matter/main'});
    await expect(matter).toContainText('Apache-2.0');
    await matter.locator('summary').click();
    await expect(matter.locator('pre')).toContainText('Apache License');
    await expect(
        dialog.getByTestId('licenses-ui').getByTestId('license-package').filter({hasText: 'svelte'}),
    ).toContainText('MIT');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
});

test('the top bar fits a phone: the tabs scroll, the icons stay reachable', async ({page}) => {
    await page.setViewportSize({width: 375, height: 700});
    await page.goto('/#/devices');
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const id of ['github', 'licenses-button', 'version-button', 'stats-button', 'config-button']) {
        await expect(page.getByTestId(id)).toBeInViewport();
    }
    await page.getByTestId('config-button').click();
    await expect(page.getByTestId('config-page')).toBeVisible();
    await page.getByTestId('stats-button').click();
    await expect(page.getByTestId('stats')).toBeInViewport({ratio: 1});
});
