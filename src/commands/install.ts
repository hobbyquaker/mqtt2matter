/* `mqtt2matter --install [--mqtt-url <url>] [--dry-run]` and `mqtt2matter --uninstall`: run mqtt2matter as the
   systemd service `mqtt2matter.service`.

     /etc/systemd/system/mqtt2matter.service   the unit, rewritten on every --install (ExecStart follows node)
     /etc/systemd/system/mqtt2matter-update.path, mqtt2matter-update.service
                                               the update from the UI: the path unit sees the request the service
                                               writes into /var/lib/mqtt2matter/update and starts the root oneshot
                                               `mqtt2matter --apply-update` (commands/update.ts)
     /etc/mqtt2matter/mqtt2matter.json         the configuration; created once, never overwritten — the UI edits it,
                                               so the directory belongs to the service user
     /var/lib/mqtt2matter/                     matter.js storage (fabrics, endpoint numbers) and the shard map
     system user mqtt2matter                   the unit runs as it

   One process serves every bridge, so there is one unit, not one per instance. Uninstalling keeps the
   configuration and the storage: the fabrics in it are what the controllers paired with. */

import {execFileSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {chmod, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {ConfigError} from '../config/index.ts';

export const SERVICE = 'mqtt2matter';
export const UNIT_PATH = `/etc/systemd/system/${SERVICE}.service`;
export const CONFIG_DIR = `/etc/${SERVICE}`;
export const CONFIG_FILE = `${CONFIG_DIR}/${SERVICE}.json`;
export const STATE_DIR = `/var/lib/${SERVICE}`;
export const UPDATE_DIR = `${STATE_DIR}/update`;
export const UPDATE_PATH_UNIT = `/etc/systemd/system/${SERVICE}-update.path`;
export const UPDATE_SERVICE_UNIT = `/etc/systemd/system/${SERVICE}-update.service`;
/** the exit code of a restart from the UI: the unit restarts the service on it (RestartForceExitStatus) and counts
    it as a clean stop (SuccessExitStatus) */
export const RESTART_EXIT_CODE = 75;

export interface InstallArgs {
    uninstall: boolean;
    dryRun: boolean;
    /** the broker written into a new configuration file */
    mqttUrl?: string | undefined;
}

export function parseInstallArgs(argv: readonly string[]): InstallArgs {
    const args: InstallArgs = {uninstall: false, dryRun: false};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === '--install') {
            continue;
        } else if (arg === '--uninstall') {
            args.uninstall = true;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--mqtt-url') {
            args.mqttUrl = argv[++i];
            if (args.mqttUrl === undefined || args.mqttUrl === '') {
                throw new ConfigError('--mqtt-url needs a URL');
            }
        } else if (arg.startsWith('--mqtt-url=')) {
            args.mqttUrl = arg.slice('--mqtt-url='.length);
        } else {
            throw new ConfigError(`unknown option ${arg}`);
        }
    }
    return args;
}

/** what the installer needs from the host; the CLI passes the real ones, the tests fakes */
export interface InstallHost {
    /** prepended to every path written or read: '' on a real host, a temporary directory in the tests */
    root: string;
    /** the node binary and the package's main.js, as the unit starts them */
    execStart: string;
    /** run a command; throws when it fails */
    exec(command: string, args: readonly string[]): void;
    /** whether a command succeeds */
    succeeds(command: string, args: readonly string[]): boolean;
    /** why this host cannot install a service (not Linux, not root, no systemd), or undefined */
    unsuitable(): string | undefined;
    out(line: string): void;
}

export function unitFile(execStart: string): string {
    return `[Unit]
Description=mqtt2matter: MQTT to Matter bridge
Documentation=https://github.com/hobbyquaker/mqtt2matter#readme
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE}
Group=${SERVICE}
Environment=MQTT2MATTER_CONFIG=${CONFIG_FILE}
# the UI's restart and update: an exit with ${RESTART_EXIT_CODE} comes back; the update goes through ${SERVICE}-update.path
Environment=MQTT2MATTER_SUPERVISOR=systemd
Environment=MQTT2MATTER_UPDATE_DIR=${UPDATE_DIR}
WorkingDirectory=${STATE_DIR}
ExecStart=${execStart}
Restart=on-failure
RestartForceExitStatus=${RESTART_EXIT_CODE}
# …and is a clean stop, not a failure, in the journal (the forced restart happens all the same)
SuccessExitStatus=${RESTART_EXIT_CODE}
RestartSec=5
TimeoutStopSec=30
SyslogIdentifier=${SERVICE}
StateDirectory=${SERVICE}
StateDirectoryMode=0750
# the UI writes the configuration back
ReadWritePaths=${CONFIG_DIR}
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export function updatePathUnit(): string {
    return `[Unit]
Description=mqtt2matter: an update requested from the UI

[Path]
PathExists=${UPDATE_DIR}/request
Unit=${SERVICE}-update.service

[Install]
WantedBy=multi-user.target
`;
}

/** the root oneshot: installs the requested version with npm and restarts the service */
export function updateServiceUnit(execStart: string): string {
    return `[Unit]
Description=mqtt2matter: install the version requested from the UI, then restart mqtt2matter

[Service]
Type=oneshot
# npm keeps its cache under HOME, which systemd does not set for a system service
Environment=HOME=/root
ExecStart=${execStart} --apply-update
TimeoutStartSec=900
SyslogIdentifier=${SERVICE}-update
`;
}

/** a new configuration file: the broker and the storage; everything else is the schema's default */
export function initialConfig(mqttUrl: string | undefined): string {
    return `${JSON.stringify({mqtt: {url: mqttUrl ?? 'mqtt://localhost:1883'}, storage: STATE_DIR, devices: {}}, null, 2)}\n`;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function install(args: InstallArgs, host: InstallHost): Promise<void> {
    const at = (path: string): string => join(host.root, path);
    const unit = unitFile(host.execStart);
    const configExists = await exists(at(CONFIG_FILE));
    if (args.dryRun) {
        host.out(`would write ${UNIT_PATH}:\n\n${unit}`);
        host.out(
            configExists ? `would keep ${CONFIG_FILE}` : `would create ${CONFIG_FILE}:\n${initialConfig(args.mqttUrl)}`,
        );
        host.out(`would write ${UPDATE_PATH_UNIT}:\n\n${updatePathUnit()}`);
        host.out(`would write ${UPDATE_SERVICE_UNIT}:\n\n${updateServiceUnit(host.execStart)}`);
        host.out(
            `would create the system user ${SERVICE}, ${STATE_DIR}, ${UPDATE_DIR}, enable ${SERVICE}-update.path, and enable and start ${SERVICE}.service`,
        );
        return;
    }
    const reason = host.unsuitable();
    if (reason !== undefined) {
        throw new ConfigError(`--install: ${reason}`);
    }
    if (!host.succeeds('id', ['-u', SERVICE])) {
        host.out(`creating the system user ${SERVICE}`);
        host.exec('useradd', [
            '--system',
            '--no-create-home',
            '--home-dir',
            STATE_DIR,
            '--shell',
            '/usr/sbin/nologin',
            SERVICE,
        ]);
    }
    await mkdir(at(STATE_DIR), {recursive: true, mode: 0o750});
    await mkdir(at(UPDATE_DIR), {recursive: true, mode: 0o750});
    await mkdir(at(CONFIG_DIR), {recursive: true, mode: 0o750});
    if (configExists) {
        host.out(`kept ${CONFIG_FILE}`);
        if (args.mqttUrl !== undefined) {
            host.out(`--mqtt-url ignored: ${CONFIG_FILE} exists; change the broker in the UI or in the file`);
        }
    } else {
        await writeFile(at(CONFIG_FILE), initialConfig(args.mqttUrl), {mode: 0o640});
        host.out(`wrote ${CONFIG_FILE}`);
    }
    // the configuration holds the broker's credentials: the service user's alone
    host.exec('chown', ['-R', `${SERVICE}:${SERVICE}`, at(CONFIG_DIR), at(STATE_DIR)]);
    await chmod(at(CONFIG_FILE), 0o640);
    await mkdir(join(host.root, '/etc/systemd/system'), {recursive: true});
    await writeFile(at(UNIT_PATH), unit, {mode: 0o644});
    host.out(`wrote ${UNIT_PATH} (ExecStart=${host.execStart})`);
    await writeFile(at(UPDATE_PATH_UNIT), updatePathUnit(), {mode: 0o644});
    await writeFile(at(UPDATE_SERVICE_UNIT), updateServiceUnit(host.execStart), {mode: 0o644});
    host.out(`wrote ${UPDATE_PATH_UNIT} and ${UPDATE_SERVICE_UNIT} (the update from the UI)`);
    host.exec('systemctl', ['daemon-reload']);
    host.exec('systemctl', ['enable', '--now', `${SERVICE}-update.path`]);
    host.exec('systemctl', ['enable', `${SERVICE}.service`]);
    // restart rather than start: a reinstall has to bring a running service onto the new unit
    host.exec('systemctl', ['restart', `${SERVICE}.service`]);
    host.out(`${SERVICE}.service enabled and started`);
    host.out(`the pairing code and QR: journalctl -u ${SERVICE} -f; the UI: http://<this host>:8282`);
}

async function uninstall(args: InstallArgs, host: InstallHost): Promise<void> {
    if (args.dryRun) {
        host.out(
            `would stop and disable ${SERVICE}.service and ${SERVICE}-update.path and remove their units; ${CONFIG_DIR} and ${STATE_DIR} stay`,
        );
        return;
    }
    const reason = host.unsuitable();
    if (reason !== undefined) {
        throw new ConfigError(`--uninstall: ${reason}`);
    }
    if (!host.succeeds('systemctl', ['disable', '--now', `${SERVICE}.service`])) {
        host.out(`${SERVICE}.service was not enabled`);
    }
    host.succeeds('systemctl', ['disable', '--now', `${SERVICE}-update.path`]);
    for (const path of [UNIT_PATH, UPDATE_PATH_UNIT, UPDATE_SERVICE_UNIT]) {
        await rm(join(host.root, path), {force: true});
    }
    host.exec('systemctl', ['daemon-reload']);
    host.out(`removed ${UNIT_PATH}, ${UPDATE_PATH_UNIT}, ${UPDATE_SERVICE_UNIT}`);
    // the storage holds the fabrics: removing it unpairs the bridge from every controller
    host.out(`kept ${CONFIG_DIR} and ${STATE_DIR} (the pairings); delete them by hand when they are no longer needed`);
}

export async function runInstall(args: InstallArgs, host: InstallHost): Promise<void> {
    await (args.uninstall ? uninstall(args, host) : install(args, host));
}

/** this host, as `sudo mqtt2matter --install` finds it */
export function systemHost(out: (line: string) => void): InstallHost {
    return {
        root: '',
        execStart: `${process.execPath} ${realpathSync(process.argv[1] ?? '')}`,
        exec: (command, args) => {
            execFileSync(command, args, {stdio: ['ignore', 'inherit', 'inherit']});
        },
        succeeds: (command, args) => {
            try {
                execFileSync(command, args, {stdio: 'ignore'});
                return true;
            } catch {
                return false;
            }
        },
        unsuitable: () => {
            if (process.platform !== 'linux') {
                return 'needs Linux with systemd';
            }
            if (process.getuid?.() !== 0) {
                return 'needs root: sudo mqtt2matter --install';
            }
            if (!existsSync('/run/systemd/system')) {
                return 'systemd is not running on this host';
            }
            return undefined;
        },
        out,
    };
}
