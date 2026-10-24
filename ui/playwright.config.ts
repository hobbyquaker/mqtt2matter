import {defineConfig, devices} from '@playwright/test';

// The suite runs against the real stack (ui/test/serve.ts): the global setup starts it on an ephemeral
// port and hands the address to the tests through the environment — nothing binds a fixed port.
// `npm run build:ui` first: the server serves ui/dist.
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
    use: {trace: 'retain-on-failure', serviceWorkers: 'block'},
    projects: [
        {name: 'desktop-light', use: {...devices['Desktop Chrome'], colorScheme: 'light'}},
        {name: 'desktop-dark', use: {...devices['Desktop Chrome'], colorScheme: 'dark'}, testMatch: /shell\.spec\.ts$/},
    ],
});
