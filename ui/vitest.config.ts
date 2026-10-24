import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

// the UI's unit tests: the pure modules (messages, the model helpers, the router, formatting); the
// `.svelte.ts` modules need the Svelte compiler, hence the plugin
export default defineConfig({
    root: import.meta.dirname,
    plugins: [svelte()],
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
    },
});
