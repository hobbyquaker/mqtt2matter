/* The licences the package ships, collected at build time from node_modules: mqtt2matter's own
   (LICENSE, NOTICE), every package of the production dependency tree (what `npm install mqtt2matter`
   puts beside it), and every package the UI bundle contains code of (svelte's runtime, qrcode, …) —
   the last as a Vite plugin, which sees exactly the modules that end up in the bundle. The result is
   `ui/dist/licenses.json`, which the UI shows behind the § in the top bar. Nothing is kept by hand. */

import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

import type {Plugin} from 'vite';

export interface PackageLicense {
    name: string;
    version: string;
    /** the SPDX expression of package.json, or what the legacy fields say */
    license: string;
    repository?: string;
    /** the text of the package's LICENSE (LICENCE, COPYING, …) file, if it has one */
    text?: string;
}

export interface Licenses {
    self: {name: string; version: string; license: string; text: string; notice: string};
    runtime: PackageLicense[];
    ui: PackageLicense[];
}

interface Manifest {
    name?: string;
    version?: string;
    license?: string | {type?: string};
    licenses?: {type?: string}[];
    repository?: string | {url?: string};
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

const ROOT = resolve(import.meta.dirname, '..');

async function manifest(dir: string): Promise<Manifest> {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest;
}

function licenseOf(pkg: Manifest): string {
    if (typeof pkg.license === 'string') {
        return pkg.license;
    }
    if (pkg.license?.type !== undefined) {
        return pkg.license.type;
    }
    const legacy = (pkg.licenses ?? []).map((l) => l.type).filter((t): t is string => t !== undefined);
    return legacy.length > 0 ? legacy.join(' OR ') : 'UNKNOWN';
}

function repositoryOf(pkg: Manifest): string | undefined {
    const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (raw === undefined || raw === '') {
        return undefined;
    }
    const github = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
    if (github !== null) {
        return `https://github.com/${github[1] ?? ''}`;
    }
    return raw
        .replace(/^git\+/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/\.git$/, '');
}

async function licenseText(dir: string): Promise<string | undefined> {
    const names = await readdir(dir);
    const file =
        names.find((n) => /^(licen[sc]e|copying)(\.(md|txt|markdown))?$/i.test(n)) ??
        names.find((n) => /^(licen[sc]e|copying)[-._]/i.test(n));
    return file === undefined ? undefined : (await readFile(join(dir, file), 'utf8')).trim();
}

export async function packageLicense(dir: string): Promise<PackageLicense> {
    const pkg = await manifest(dir);
    const entry: PackageLicense = {name: pkg.name ?? dir, version: pkg.version ?? '', license: licenseOf(pkg)};
    const repository = repositoryOf(pkg);
    if (repository !== undefined) {
        entry.repository = repository;
    }
    const text = await licenseText(dir);
    if (text !== undefined) {
        entry.text = text;
    }
    return entry;
}

/** where node resolves `name` from `from`: the nearest node_modules up the tree */
function resolvePackage(name: string, from: string): string | undefined {
    let dir = from;
    for (;;) {
        const candidate = join(dir, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

const byName = (a: PackageLicense, b: PackageLicense): number =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

/** the production dependency tree of the package at `root`, without the package itself */
export async function runtimeLicenses(root = ROOT): Promise<PackageLicense[]> {
    const seen = new Set<string>();
    const result: PackageLicense[] = [];
    const visit = async (dir: string): Promise<void> => {
        const pkg = await manifest(dir);
        for (const name of Object.keys({...pkg.dependencies, ...pkg.optionalDependencies})) {
            const found = resolvePackage(name, dir);
            // an optional dependency for another platform is not installed
            if (found === undefined || seen.has(found)) {
                continue;
            }
            seen.add(found);
            result.push(await packageLicense(found));
            await visit(found);
        }
    };
    await visit(root);
    return dedupe(result).sort(byName);
}

/** one entry per name and version (npm may install the same version twice, nested) */
function dedupe(entries: PackageLicense[]): PackageLicense[] {
    const map = new Map<string, PackageLicense>();
    for (const entry of entries) {
        map.set(`${entry.name}@${entry.version}`, entry);
    }
    return [...map.values()];
}

/** the package directory a module id of the bundle lies in, if it lies in node_modules */
export function packageDirOf(id: string): string | undefined {
    // Vite's ids use forward slashes on every platform
    const path = id
        .replace(/^\0/, '')
        .replace(/[?#].*$/, '')
        .replace(/\\/g, '/');
    const marker = '/node_modules/';
    const index = path.lastIndexOf(marker);
    if (index < 0) {
        return undefined;
    }
    const rest = path.slice(index + marker.length).split('/');
    const parts = rest[0]?.startsWith('@') === true ? rest.slice(0, 2) : rest.slice(0, 1);
    if (parts.length === 0 || parts.some((p) => p === '')) {
        return undefined;
    }
    return path.slice(0, index + marker.length) + parts.join('/');
}

export async function uiLicenses(moduleIds: Iterable<string>): Promise<PackageLicense[]> {
    const dirs = new Set<string>();
    for (const id of moduleIds) {
        const dir = packageDirOf(id);
        if (dir !== undefined && existsSync(join(dir, 'package.json'))) {
            dirs.add(dir);
        }
    }
    return dedupe(await Promise.all([...dirs].map((dir) => packageLicense(dir)))).sort(byName);
}

export async function collectLicenses(moduleIds: Iterable<string>, root = ROOT): Promise<Licenses> {
    const pkg = await manifest(root);
    return {
        self: {
            name: pkg.name ?? 'mqtt2matter',
            version: pkg.version ?? '',
            license: licenseOf(pkg),
            text: (await readFile(join(root, 'LICENSE'), 'utf8')).trim(),
            notice: (await readFile(join(root, 'NOTICE'), 'utf8')).trim(),
        },
        runtime: await runtimeLicenses(root),
        ui: await uiLicenses(moduleIds),
    };
}

/** the Vite plugin: writes `licenses.json` beside the bundle, from the modules the bundle holds */
export function licenses(): Plugin {
    return {
        name: 'mqtt2matter-licenses',
        apply: 'build',
        async generateBundle(_options, bundle) {
            const ids: string[] = [];
            for (const chunk of Object.values(bundle)) {
                if (chunk.type === 'chunk') {
                    ids.push(...Object.keys(chunk.modules));
                }
            }
            this.emitFile({
                type: 'asset',
                fileName: 'licenses.json',
                source: JSON.stringify(await collectLicenses(ids)),
            });
        },
    };
}
