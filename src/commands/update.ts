/* `mqtt2matter --apply-update`: the root side of the update from the UI.

   The service runs as an unprivileged user and cannot write the global npm prefix (/usr/local/lib). So the UI's
   "Update" only writes the wanted version into a request file in the service's state directory; a systemd path
   unit that `--install` sets up (`mqtt2matter-update.path`, PathExists=) starts `mqtt2matter-update.service`, a
   root oneshot that runs this command: it takes the request, installs exactly `mqtt2matter@<version>` from the
   registry with npm, logs into the same directory for the UI, and restarts mqtt2matter.service. No sudo rule, no
   polkit: the only thing the service user can ask for is a version string of the one package.

   The directory belongs to the service user, so nothing in it is trusted: the request is opened without following
   a symlink and must be a short regular file with a version in it; the log is created anew (O_EXCL), never written
   through a link. */

import {execFileSync, spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open, unlink} from 'node:fs/promises';
import {join} from 'node:path';

export const UPDATE_REQUEST = 'request';
export const UPDATE_LOG = 'update.log';
export const PACKAGE = 'mqtt2matter';

export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

export interface UpdateHost {
    /** run the installer; resolves with its exit code; its output goes to `log` */
    install(version: string, log: (text: string) => void): Promise<number>;
    /** restart the service onto the new version */
    restart(): void;
}

/** the request's version, or an error; the request is gone afterwards either way */
async function takeRequest(dir: string): Promise<string> {
    const path = join(dir, UPDATE_REQUEST);
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        await unlink(path).catch(() => undefined);
        throw new Error(`no readable request (${(error as NodeJS.ErrnoException).code ?? 'error'})`, {cause: error});
    }
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 64) {
            throw new Error('the request is not a short regular file');
        }
        return (await handle.readFile('utf8')).trim();
    } finally {
        await handle.close();
        await unlink(path).catch(() => undefined);
    }
}

/** take the request, install the version, restart; the exit code for systemd */
export async function applyUpdate(dir: string, host: UpdateHost): Promise<number> {
    const logPath = join(dir, UPDATE_LOG);
    await unlink(logPath).catch(() => undefined);
    // O_EXCL: a link planted after the unlink makes this fail instead of writing through it
    const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    let pending: Promise<unknown> = Promise.resolve();
    const write = (text: string): void => {
        pending = pending.then(() => log.write(text.endsWith('\n') ? text : `${text}\n`));
    };
    try {
        let version: string;
        try {
            version = await takeRequest(dir);
        } catch (error) {
            write(`refused: ${(error as Error).message}`);
            return 1;
        }
        if (!VERSION_PATTERN.test(version)) {
            write('refused: the request holds no version');
            return 1;
        }
        write(`installing ${PACKAGE}@${version}`);
        const code = await host.install(version, write);
        if (code !== 0) {
            write(`failed: npm exited with ${code}; ${PACKAGE} keeps running the old version`);
            return 1;
        }
        write(`installed ${PACKAGE}@${version}; restarting`);
        host.restart();
        return 0;
    } finally {
        await pending.catch(() => undefined);
        await log.close();
    }
}

/** the real host: npm next to this node, systemctl */
export function systemUpdateHost(npm: string): UpdateHost {
    return {
        install: (version, log) =>
            new Promise((resolve) => {
                const child = spawn(npm, ['install', '--global', '--no-audit', '--no-fund', `${PACKAGE}@${version}`], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                child.stdout.on('data', (chunk: Buffer) => {
                    log(chunk.toString('utf8'));
                });
                child.stderr.on('data', (chunk: Buffer) => {
                    log(chunk.toString('utf8'));
                });
                child.on('error', (error) => {
                    log(`npm: ${error.message}`);
                    resolve(127);
                });
                child.on('close', (code) => {
                    resolve(code ?? 1);
                });
            }),
        restart: () => {
            // --no-block: queue the restart and return; this oneshot must not wait for the service it restarts
            execFileSync('systemctl', ['--no-block', 'restart', `${PACKAGE}.service`], {stdio: 'ignore'});
        },
    };
}
