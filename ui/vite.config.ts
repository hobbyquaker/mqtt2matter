import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vite';

import {licenses} from '../scripts/licenses.ts';

// Built into ui/dist, which src/server serves. In development Vite serves the UI and proxies the API
// (REST and the WebSocket) to a running mqtt2matter: `npm run dev:ui`, with UI_API for another address.
// The build also writes licenses.json, the licences of what ships (scripts/licenses.ts).
const api = process.env.UI_API ?? 'http://127.0.0.1:8282';

export default defineConfig({
    root: import.meta.dirname,
    plugins: [svelte(), licenses()],
    build: {outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022'},
    server: {
        port: 5173,
        proxy: {'/api': {target: api, ws: true, changeOrigin: false}},
    },
});
