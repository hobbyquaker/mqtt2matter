import {expect, test} from './fixtures.ts';

test('the version section: check, the update and restart dialogs', async ({page}) => {
    await page.goto('/#/config');
    const version = page.getByTestId('version');
    await expect(version.getByTestId('version-current')).toHaveText('0.0.0-ui-test');
    await version.getByTestId('check-update').click();
    await expect(version.getByTestId('version-latest')).toContainText('0.0.1');
    await expect(version.getByTestId('version-latest')).toContainText('newer');
    // the header offers it too
    await expect(page.getByTestId('update-available')).toContainText('0.0.1');

    // the update asks first; Cancel changes nothing
    await version.getByTestId('update').click();
    await expect(page.getByText('Install mqtt2matter 0.0.1 and restart?')).toBeVisible();
    await page.getByRole('button', {name: 'Cancel'}).click();
    await expect(page.getByText('Install mqtt2matter 0.0.1 and restart?')).toHaveCount(0);
    await expect(version.getByTestId('waiting')).toHaveCount(0);

    // the restart asks first; OK waits for the bridge to come back (the test stack does not exit)
    await version.getByTestId('restart').click();
    await expect(page.getByText('Restart mqtt2matter?')).toBeVisible();
    await page.getByTestId('dialog-ok').click();
    await expect(version.getByTestId('waiting')).toBeVisible();
});
