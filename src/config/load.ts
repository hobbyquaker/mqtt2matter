/* Loading the configuration: a JSON file, then the environment on top of it. The environment wins
   because that is how a container is configured; the file is what the UI edits (phase 3). */

import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {z} from 'zod';

import {migrateDevices} from '../model/migrate.ts';
import {type Config, ConfigSchema} from './schema.ts';

export const DEFAULT_CONFIG_FILE = 'mqtt2matter.json';

/** the environment variables and the config paths they override */
export const ENV = {
    /** the config file; also the first command line argument */
    MQTT2MATTER_CONFIG: 'config file',
    MQTT2MATTER_MQTT_URL: 'mqtt.url',
    MQTT2MATTER_MQTT_USERNAME: 'mqtt.username',
    MQTT2MATTER_MQTT_PASSWORD: 'mqtt.password',
    MQTT2MATTER_MQTT_CLIENT_ID: 'mqtt.clientId',
    MQTT2MATTER_STORAGE: 'storage',
    MQTT2MATTER_LOG_LEVEL: 'log.level',
    MQTT2MATTER_MATTER_LOG_LEVEL: 'log.matter',
    MQTT2MATTER_SERVER_HOST: 'server.host',
    MQTT2MATTER_SERVER_PORT: 'server.port',
    MQTT2MATTER_AUTH: 'server.auth.mode',
    MQTT2MATTER_AUTH_PASSWORD: 'server.auth.password',
    MQTT2MATTER_AUTH_PROXY_HEADER: 'server.auth.proxyHeader',
    MQTT2MATTER_AUTH_PROXY_LOGOUT_URL: 'server.auth.proxyLogoutUrl',
} as const;

/** the environment paths whose values are numbers in the schema */
const NUMERIC_PATHS: ReadonlySet<string> = new Set(['server.port']);

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPath(target: Record<string, unknown>, path: string, value: string | number): void {
    const keys = path.split('.');
    const last = keys.pop() ?? path;
    let cursor = target;
    for (const key of keys) {
        const next = cursor[key];
        if (!isRecord(next)) {
            cursor[key] = {};
        }
        cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[last] = value;
}

/** the config paths the environment sets */
export function envOverrides(env: Env): string[] {
    const paths: string[] = [];
    for (const [name, path] of Object.entries(ENV)) {
        const value = env[name];
        if (path !== 'config file' && value !== undefined && value !== '') {
            paths.push(path);
        }
    }
    return paths;
}

/** a copy of `raw` with the environment's overrides written in */
export function applyEnv(raw: unknown, env: Env): Record<string, unknown> {
    const result: Record<string, unknown> = isRecord(raw) ? structuredClone(raw) : {};
    for (const [name, path] of Object.entries(ENV)) {
        if (path === 'config file') {
            continue;
        }
        const value = env[name];
        if (value !== undefined && value !== '') {
            setPath(result, path, NUMERIC_PATHS.has(path) && /^\d+$/.test(value) ? Number(value) : value);
        }
    }
    return result;
}

/** validate a raw object; the error message lists every problem with its path */
export function parseConfig(raw: unknown): Config {
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
        throw new ConfigError(`invalid configuration:\n${z.prettifyError(result.error)}`);
    }
    return result.data;
}

/** the config file to read: the first argument, else the environment, else the default in the cwd */
export function configPath(argv: readonly string[], env: Env): {path: string; explicit: boolean} {
    const fromArgs = argv[2];
    if (fromArgs !== undefined && fromArgs !== '') {
        return {path: resolve(fromArgs), explicit: true};
    }
    const fromEnv = env.MQTT2MATTER_CONFIG;
    if (fromEnv !== undefined && fromEnv !== '') {
        return {path: resolve(fromEnv), explicit: true};
    }
    return {path: resolve(DEFAULT_CONFIG_FILE), explicit: false};
}

export interface LoadOptions {
    /** the file; default: `configPath(process.argv, process.env)` */
    path?: string;
    /** a missing file is an error (true) or an empty configuration (false, the default for the default path) */
    explicit?: boolean;
    env?: Env;
}

export interface Loaded {
    config: Config;
    path: string;
    /** false when the file did not exist and the defaults were used */
    fromFile: boolean;
    /** the file's content as written, without the environment and without defaults — what an editor saves back */
    raw: Record<string, unknown>;
    /** the config paths the environment overrides (`mqtt.url`), which an editor must not write back */
    overridden: string[];
    /** the devices brought from an earlier format to the current one in `raw`; the file is unchanged until saved */
    migrated: string[];
}

/** bring a raw file content written by an earlier version to the current format, in place; the migrated devices */
export function migrateRaw(raw: Record<string, unknown>): string[] {
    return migrateDevices(raw.devices);
}

export async function loadConfig(options: LoadOptions = {}): Promise<Loaded> {
    const env = options.env ?? process.env;
    const located = options.path === undefined ? configPath(process.argv, env) : {path: options.path, explicit: true};
    const explicit = options.explicit ?? located.explicit;
    let raw: unknown = {};
    let fromFile = false;
    try {
        const text = await readFile(located.path, 'utf8');
        try {
            raw = JSON.parse(text);
        } catch (error) {
            throw new ConfigError(`${located.path} is not valid JSON: ${(error as Error).message}`);
        }
        fromFile = true;
    } catch (error) {
        if (error instanceof ConfigError) {
            throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || explicit) {
            throw new ConfigError(`cannot read ${located.path}: ${(error as Error).message}`);
        }
    }
    if (fromFile && !isRecord(raw)) {
        throw new ConfigError(`${located.path} must hold a JSON object`);
    }
    const migrated = isRecord(raw) ? migrateRaw(raw) : [];
    return {
        config: parseConfig(applyEnv(raw, env)),
        path: located.path,
        fromFile,
        raw: isRecord(raw) ? raw : {},
        overridden: envOverrides(env),
        migrated,
    };
}
