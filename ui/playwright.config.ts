import {defineConfig, devices} from '@playwright/test';

// The suite runs against the real stack (ui/test/serve.ts): the global setup starts it on an ephemeral
// port and hands the address to the tests through the environment — nothing binds a fixed port.
// `npm run build:ui` first: the server serves ui/dist.
// Chromium in CI (ubuntu, `npx playwright install --with-deps chromium`); elsewhere Firefox, which renders
// where some headless Chromium builds do not (WSL); PW_BROWSER overrides.
const browser = process.env.PW_BROWSER ?? (process.env.CI ? 'chromium' : 'firefox');
const desktop = browser === 'firefox' ? devices['Desktop Firefox'] : devices['Desktop Chrome'];

export default defineConfig({
    testDir: 'test/e2e',
    globalSetup: './test/global-setup.ts',
    timeout: 30_000,
    expect: {timeout: 10_000},
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never', outputFolder: '../playwright-report'}]] : 'list',
    outputDir: '../test-results',
    // a trace records screenshots, which hang in some headless Chromium builds: only where it is read, in CI
    use: {trace: process.env.CI ? 'retain-on-failure' : 'off', serviceWorkers: 'block'},
    projects: [
        {name: 'desktop-light', use: {...desktop, colorScheme: 'light'}},
        {name: 'desktop-dark', use: {...desktop, colorScheme: 'dark'}, testMatch: /shell\.spec\.ts$/},
    ],
});
