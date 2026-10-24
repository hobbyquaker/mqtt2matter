/* Restart and update from the UI.

   - Restart: under systemd (`--install` writes `MQTT2MATTER_SUPERVISOR=systemd` and `RestartForceExitStatus=75`
     into the unit) the process stops cleanly and exits with 75, and systemd starts it again. Anywhere else there
     is nothing that would bring it back, so the UI says so instead of exiting.
   - Update: the registry's `latest` of the package, checked at most every few hours; "not published" while there
     is none. Installing needs root (the global npm prefix), so the service writes the version into the request
     file of `MQTT2MATTER_UPDATE_DIR`; the root oneshot `mqtt2matter --apply-update` (commands/update.ts), started
     by the path unit `--install` sets up, installs it, logs into the same directory and restarts the service. */

import {readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {RESTART_EXIT_CODE} from '../commands/install.ts';
import {PACKAGE, UPDATE_LOG, UPDATE_REQUEST, VERSION_PATTERN} from '../commands/update.ts';

export {RESTART_EXIT_CODE};
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

/** the registry's latest version; undefined when the package is not published */
export type FetchLatest = () => Promise<string | undefined>;

export const npmLatest: FetchLatest = async () => {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
        headers: {accept: 'application/json'},
        signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`the registry answered ${response.status}`);
    }
    const body = (await response.json()) as {version?: unknown};
    return typeof body.version === 'string' ? body.version : undefined;
};

/** -1, 0, 1 over x.y.z; a pre-release sorts before its release */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): [number[], string] => {
        const [core = '', pre = ''] = v.split('-', 2);
        return [core.split('.').map((n) => Number(n) || 0), pre];
    };
    const [ca, pa] = parse(a);
    const [cb, pb] = parse(b);
    for (let i = 0; i < 3; i++) {
        const d = (ca[i] ?? 0) - (cb[i] ?? 0);
        if (d !== 0) {
            return Math.sign(d);
        }
    }
    if (pa === pb) {
        return 0;
    }
    if (pa === '') {
        return 1;
    }
    if (pb === '') {
        return -1;
    }
    return pa < pb ? -1 : 1;
}

export interface UpdaterOptions {
    current: string;
    /** `systemd` when the unit restarts the process on RESTART_EXIT_CODE */
    supervisor?: string | undefined;
    /** where the update request goes (the path unit watches it) */
    updateDir?: string | undefined;
    fetchLatest?: FetchLatest;
    now?: () => number;
}

export interface UpdateStatus {
    current: string;
    /** the registry's latest; absent when not published or not checked */
    latest?: string;
    published: boolean | undefined;
    newer: boolean;
    checkedAt?: string;
    error?: string;
    restart: {available: boolean; reason?: string};
    update: {available: boolean; reason?: string; requested?: string; log: string[]};
}

export class Updater {
    private readonly options: UpdaterOptions;
    private readonly fetchLatest: FetchLatest;
    private readonly now: () => number;
    private latest: string | undefined;
    private published: boolean | undefined;
    private checkedAt: number | undefined;
    private error: string | undefined;
    private checking: Promise<void> | undefined;

    constructor(options: UpdaterOptions) {
        this.options = options;
        this.fetchLatest = options.fetchLatest ?? npmLatest;
        this.now = options.now ?? Date.now;
    }

    get restartReason(): string | undefined {
        return this.options.supervisor === 'systemd'
            ? undefined
            : 'not running as the systemd service (mqtt2matter --install): nothing would start it again';
    }

    /** the latest version seen, without asking the registry (for /api/status) */
    get known(): {latest?: string; newer: boolean} {
        return {
            ...(this.latest === undefined ? {} : {latest: this.latest}),
            newer: this.latest !== undefined && compareVersions(this.latest, this.options.current) > 0,
        };
    }

    /** ask the registry when the last answer is older than the interval (or `force`) */
    async check(force = false): Promise<void> {
        if (!force && this.checkedAt !== undefined && this.now() - this.checkedAt < CHECK_INTERVAL_MS) {
            return;
        }
        this.checking ??= (async () => {
            try {
                this.latest = await this.fetchLatest();
                this.published = this.latest !== undefined;
                this.error = undefined;
            } catch (error) {
                this.error = error instanceof Error ? error.message : String(error);
            } finally {
                this.checkedAt = this.now();
                this.checking = undefined;
            }
        })();
        await this.checking;
    }

    private async updateReason(): Promise<string | undefined> {
        const dir = this.options.updateDir;
        if (this.options.supervisor !== 'systemd' || dir === undefined) {
            return 'installed without the systemd service (mqtt2matter --install): update with npm or deploy.sh';
        }
        try {
            if (!(await stat(dir)).isDirectory()) {
                return `${dir} is not a directory`;
            }
        } catch {
            return `${dir} is missing: run mqtt2matter --install again`;
        }
        return undefined;
    }

    private async readLog(): Promise<string[]> {
        if (this.options.updateDir === undefined) {
            return [];
        }
        try {
            const text = await readFile(join(this.options.updateDir, UPDATE_LOG), 'utf8');
            return text
                .split('\n')
                .filter((line) => line !== '')
                .slice(-200);
        } catch {
            return [];
        }
    }

    private async pending(): Promise<string | undefined> {
        if (this.options.updateDir === undefined) {
            return undefined;
        }
        try {
            return (await readFile(join(this.options.updateDir, UPDATE_REQUEST), 'utf8')).trim();
        } catch {
            return undefined;
        }
    }

    async status(): Promise<UpdateStatus> {
        const restartReason = this.restartReason;
        const updateReason = await this.updateReason();
        const requested = await this.pending();
        return {
            current: this.options.current,
            ...(this.latest === undefined ? {} : {latest: this.latest}),
            published: this.published,
            newer: this.known.newer,
            ...(this.checkedAt === undefined ? {} : {checkedAt: new Date(this.checkedAt).toISOString()}),
            ...(this.error === undefined ? {} : {error: this.error}),
            restart: {
                available: restartReason === undefined,
                ...(restartReason === undefined ? {} : {reason: restartReason}),
            },
            update: {
                available: updateReason === undefined,
                ...(updateReason === undefined ? {} : {reason: updateReason}),
                ...(requested === undefined ? {} : {requested}),
                log: await this.readLog(),
            },
        };
    }

    /** write the request for the root helper; the reason it cannot be done, or undefined */
    async request(version: string): Promise<string | undefined> {
        const reason = await this.updateReason();
        if (reason !== undefined) {
            return reason;
        }
        if (!VERSION_PATTERN.test(version)) {
            return 'not a version';
        }
        if (this.latest === undefined) {
            return this.published === false
                ? `${PACKAGE} is not published on npm yet`
                : 'no version known yet: check first';
        }
        if (version !== this.latest || compareVersions(version, this.options.current) <= 0) {
            return `only the newer latest version ${this.latest} can be installed`;
        }
        const dir = this.options.updateDir ?? '';
        const tmp = join(dir, `.${UPDATE_REQUEST}.${process.pid}`);
        await writeFile(tmp, `${version}\n`, {mode: 0o640});
        // the rename makes the path unit see a complete file
        await rename(tmp, join(dir, UPDATE_REQUEST));
        return undefined;
    }
}
