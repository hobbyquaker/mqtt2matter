import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // every file gets its own process: matter.js keeps a process-wide Environment (storage, mDNS)
        pool: 'forks',
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
