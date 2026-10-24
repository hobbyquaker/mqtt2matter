import {expect, test} from './fixtures.ts';

const PASSWORD = 'correct horse';

// whatever happens in the test, the stack is open again for the next spec
test.afterEach(async ({request}) => {
    const state = (await (await request.get('/api/auth')).json()) as {mode: string};
    if (state.mode === 'password') {
        await request.post('/api/auth/login', {data: {password: PASSWORD}});
        await request.put('/api/auth', {data: {mode: 'none'}});
    }
});

test('set a password, log out, log in again, open the UI again', async ({page}) => {
    await page.goto('/#/config');
    const access = page.getByTestId('access');
    await access.getByTestId('access-mode').selectOption('password');
    await access.getByTestId('access-password').fill(PASSWORD);
    await access.getByTestId('access-repeat').fill('something else');
    await expect(access.getByTestId('save-access')).toBeDisabled();
    await access.getByTestId('access-repeat').fill(PASSWORD);
    await access.getByTestId('save-access').click();
    await page.getByTestId('dialog-ok').click();
    // whoever set the password stays logged in
    await expect(page.getByTestId('logout')).toBeVisible();
    await expect(page.getByTestId('app')).toBeVisible();

    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login')).toBeVisible();
    await expect(page.getByTestId('app')).toHaveCount(0);

    // a reload does not get past the login either
    await page.reload();
    await expect(page.getByTestId('login-password')).toBeVisible();
    await page.getByTestId('login-password').fill('wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toHaveText('wrong password');

    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-password').press('Enter');
    await expect(page.getByTestId('app')).toBeVisible();
    await expect(page.getByTestId('config-page')).toBeVisible();

    await page.goto('/#/config');
    await access.getByTestId('access-mode').selectOption('none');
    await access.getByTestId('save-access').click();
    await page.getByTestId('dialog-ok').click();
    await expect(page.getByTestId('logout')).toHaveCount(0);
});
