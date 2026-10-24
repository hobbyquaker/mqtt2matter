/* `mqtt2matter --import-z2m [config.json] [--base-topic zigbee2mqtt] [--dry-run] [--no-groups]
   [--timeout 15]`: connect to the broker of the configuration, read the retained `bridge/devices` and
   `bridge/groups`, adopt every supported device that is not in the file yet, re-sync the ones that are
   (the user's edits carried over, conflicts listed), mark the ones zigbee2mqtt no longer describes as
   orphaned, write the file back and report. The normal start afterwards logs the pairing code. */

import {readFile, writeFile} from 'node:fs/promises';

import {applyEnv, ConfigError, loadConfig, parseConfig} from '../config/index.ts';
import {z2m} from '../importers/index.ts';
import {describeError, type Logger, silentLogger} from '../log.ts';
import {DevicesSchema, type DevicesInput, validateDevices} from '../model/index.ts';
import {MqttClient} from '../mqtt/index.ts';

export interface ImportZ2mArgs {
    configPath?: string | undefined;
    baseTopic: string;
    dryRun: boolean;
    groups: boolean;
    /** seconds to wait for the retained bridge topics */
    timeout: number;
}

export function parseImportArgs(argv: readonly string[]): ImportZ2mArgs {
    const args: ImportZ2mArgs = {baseTopic: z2m.DEFAULT_BASE_TOPIC, dryRun: false, groups: true, timeout: 15};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === '--base-topic') {
            args.baseTopic = argv[++i] ?? args.baseTopic;
        } else if (arg.startsWith('--base-topic=')) {
            args.baseTopic = arg.slice('--base-topic='.length);
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--no-groups') {
            args.groups = false;
        } else if (arg === '--timeout') {
            args.timeout = Number(argv[++i] ?? args.timeout);
        } else if (arg.startsWith('--timeout=')) {
            args.timeout = Number(arg.slice('--timeout='.length));
        } else if (arg.startsWith('--')) {
            throw new ConfigError(`unknown option ${arg}`);
        } else {
            args.configPath = arg;
        }
    }
    if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
        throw new ConfigError('--timeout needs a number of seconds');
    }
    return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** the config file as it is on disk (no defaults filled in), so it can be written back as the user left it */
async function readRawConfig(path: string, fromFile: boolean): Promise<Record<string, unknown>> {
    if (!fromFile) {
        return {};
    }
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) {
        throw new ConfigError(`${path} is not a JSON object`);
    }
    return parsed;
}

const MARK: Record<z2m.SyncStatus, string> = {
    new: '+',
    updated: '~',
    restored: '~',
    unchanged: '=',
    orphaned: '-',
    invalid: '!',
    unsupported: '?',
};

/** one line per device, the way the report reads on a terminal */
export function formatReport(report: readonly z2m.SyncEntry[]): string[] {
    const lines: string[] = [];
    for (const entry of report) {
        const types = entry.device?.endpoints.map((e) => `${e.id ?? 'main'}: ${e.deviceTypes.join('+')}`).join(', ');
        const detail =
            entry.status === 'unsupported' || entry.status === 'invalid' ? entry.notes.join('; ') : (types ?? '');
        lines.push(`${MARK[entry.status]} ${entry.status.padEnd(11)} ${entry.key}  ${entry.name}  ${detail}`);
        for (const conflict of entry.conflicts) {
            lines.push(
                `    conflict ${conflict.path}: ${conflict.reason} (edit ${JSON.stringify(conflict.user)}, importer ${JSON.stringify(conflict.now)})`,
            );
        }
        if (entry.unmapped.length > 0 && entry.status !== 'unchanged') {
            lines.push(`    not mapped: ${entry.unmapped.join(', ')}`);
        }
        if (entry.status === 'invalid') {
            for (const note of entry.notes) {
                lines.push(`    ${note}`);
            }
        }
    }
    return lines;
}

export interface ImportIo {
    out(line: string): void;
    log?: Logger;
    env?: Record<string, string | undefined>;
}

/** run the import; returns the process exit code */
export async function importZ2m(args: ImportZ2mArgs, io: ImportIo): Promise<number> {
    const env = io.env ?? process.env;
    const log = io.log ?? silentLogger;
    const {config, path, fromFile} = await loadConfig({
        ...(args.configPath === undefined ? {} : {path: args.configPath}),
        env,
    });
    const raw = await readRawConfig(path, fromFile);
    const existing = DevicesSchema.safeParse(raw.devices ?? {});
    if (!existing.success) {
        throw new ConfigError(`${path}: the devices do not validate; fix the file first`);
    }
    const devices = (isRecord(raw.devices) ? raw.devices : {}) as DevicesInput;

    const source = new z2m.Z2mSource(args.baseTopic);
    const mqtt = new MqttClient(
        {
            url: config.mqtt.url,
            username: config.mqtt.username,
            password: config.mqtt.password,
            clientId: config.mqtt.clientId,
            connectTimeout: args.timeout * 1000,
        },
        log.child('mqtt'),
    );
    io.out(
        `connecting to ${config.mqtt.url}, reading ${source.devicesTopic}${args.groups ? ` and ${source.groupsTopic}` : ''}`,
    );
    let error: unknown;
    mqtt.on('message', (topic, payload) => {
        try {
            source.handle(topic, payload);
        } catch (e) {
            error = e;
        }
    });
    try {
        await mqtt.connect();
        await mqtt.subscribe(source.devicesTopic);
        if (args.groups) {
            await mqtt.subscribe(source.groupsTopic);
        }
        const deadline = Date.now() + args.timeout * 1000;
        while (source.devices === undefined && error === undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (error !== undefined) {
            throw error instanceof Error ? error : new Error(describeError(error));
        }
        if (source.devices === undefined) {
            throw new ConfigError(
                `no retained ${source.devicesTopic} within ${args.timeout} s — is zigbee2mqtt on this broker, and is its base topic "${args.baseTopic}"?`,
            );
        }
        // the groups come right after the devices; give them a moment
        const groupsDeadline = Date.now() + 2000;
        while (args.groups && source.groups === undefined && Date.now() < groupsDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    } finally {
        await mqtt.close();
    }
    if (!args.groups) {
        source.groups = undefined;
    }
    const discovery = source.discover();
    const {devices: adopted, report} = z2m.adopt(devices, discovery);
    for (const line of formatReport(report)) {
        io.out(line);
    }
    const count = (status: z2m.SyncStatus): number => report.filter((e) => e.status === status).length;
    io.out(
        `${count('new')} new, ${count('updated') + count('restored')} updated, ${count('unchanged')} unchanged, ${count('orphaned')} orphaned, ${count('invalid')} invalid, ${count('unsupported')} unsupported`,
    );
    const nextRaw = {...raw, devices: adopted};
    const next = parseConfig(applyEnv(nextRaw, env));
    let errors = 0;
    for (const [key, result] of validateDevices(next.devices)) {
        for (const issue of result.issues) {
            io.out(`${issue.level.toUpperCase()} ${key} ${issue.path}: ${issue.message}`);
            if (issue.level === 'error') {
                errors++;
            }
        }
    }
    if (args.dryRun) {
        io.out(`dry run: ${path} not written`);
    } else {
        await writeFile(path, `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf8');
        io.out(`written ${path}: ${Object.keys(adopted).length} devices`);
    }
    if (errors > 0) {
        io.out(`${errors} device(s) have errors and will not be built; edit them or run --check`);
    }
    return 0;
}
