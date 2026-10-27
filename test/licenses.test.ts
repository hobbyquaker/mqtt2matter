/* The licence list the build writes beside the UI: mqtt2matter's own licence and NOTICE, every package of
   the production dependency tree with its licence text, and the packages a bundle's module ids lie in. */

import {join, resolve} from 'node:path';

import {describe, expect, it} from 'vitest';

import {collectLicenses, packageDirOf, runtimeLicenses, uiLicenses} from '../scripts/licenses.ts';

const root = resolve(import.meta.dirname, '..');

describe('the licences', () => {
    it('collects the production dependency tree with each licence text', async () => {
        const runtime = await runtimeLicenses(root);
        const names = runtime.map((p) => p.name);
        for (const name of ['@matter/main', '@matter/protocol', 'mqtt', 'ws', 'zod', '@huggingface/jinja']) {
            expect(names, name).toContain(name);
        }
        const matter = runtime.find((p) => p.name === '@matter/main');
        expect(matter?.license).toBe('Apache-2.0');
        expect(matter?.text).toMatch(/Apache License/);
        // nothing of the development tree
        for (const name of ['vite', 'svelte', 'vitest', 'aedes', 'typescript']) {
            expect(names, name).not.toContain(name);
        }
        expect(new Set(names.map((n, i) => `${n}@${runtime[i]?.version ?? ''}`)).size).toBe(runtime.length);
        for (const entry of runtime) {
            expect(entry.license, entry.name).not.toBe('UNKNOWN');
        }
    });

    it('finds the package a bundled module lies in', async () => {
        const nm = join(root, 'node_modules');
        expect(packageDirOf(`${nm}/svelte/src/internal/client/index.js`)).toBe(`${nm}/svelte`);
        expect(packageDirOf(`\0${nm}/@scope/pkg/lib/a.js?commonjs-proxy`)).toBe(`${nm}/@scope/pkg`);
        expect(packageDirOf(`${nm}/a/node_modules/b/index.js`)).toBe(`${nm}/a/node_modules/b`);
        expect(packageDirOf(`${root}/ui/src/App.svelte`)).toBeUndefined();
        const ui = await uiLicenses([
            `${nm}/svelte/src/index-client.js`,
            `${nm}/qrcode/lib/browser.js`,
            `${root}/ui/src/main.ts`,
        ]);
        expect(ui.map((p) => `${p.name} ${p.license}`)).toEqual(['qrcode MIT', 'svelte MIT']);
    });

    it("puts mqtt2matter's own licence and NOTICE first", async () => {
        const all = await collectLicenses([], root);
        expect(all.self).toMatchObject({name: 'mqtt2matter', license: 'Apache-2.0'});
        expect(all.self.text).toMatch(/Apache License/);
        expect(all.self.notice).toMatch(/mqtt2matter/);
        expect(all.ui).toEqual([]);
    });
});
