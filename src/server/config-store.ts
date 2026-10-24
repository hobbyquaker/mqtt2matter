/* The configuration file as the UI edits it. The store keeps two views: the raw file content (what the
   user wrote, without defaults and without the environment's overrides — what is written back) and the
   parsed, running configuration the application holds. A device is saved raw and handed to the
   application parsed; the paths the environment sets are refused, because the file would not win. */

import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {z} from 'zod';

import {ConfigSchema, type Config} from '../config/schema.ts';
import {DEVICE_KEY_PATTERN, DeviceSchema, type DeviceConfig} from '../model/schema.ts';
import {HttpError} from './http.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ConfigStoreOptions {
    path: string;
    raw: Record<string, unknown>;
    config: Config;
    /** config paths the environment overrides; a save that touches one is refused */
    overridden?: readonly string[];
}

/** the top-level settings the UI edits (everything but the devices) */
export const SETTINGS_KEYS = [
    'mqtt',
    'storage',
    'log',
    'vendorId',
    'productId',
    'bridges',
    'server',
    'presets',
    'importers',
] as const;

export class ConfigStore {
    readonly path: string;
    readonly raw: Record<string, unknown>;
    readonly config: Config;
    readonly overridden: readonly string[];
    private writing: Promise<void> = Promise.resolve();

    constructor(options: ConfigStoreOptions) {
        this.path = options.path;
        this.raw = options.raw;
        this.config = options.config;
        this.overridden = options.overridden ?? [];
    }

    /** the raw devices, as the file has them */
    get rawDevices(): Record<string, unknown> {
        const devices = this.raw.devices;
        return isRecord(devices) ? devices : {};
    }

    rawDevice(key: string): unknown {
        return this.rawDevices[key];
    }

    /** the raw settings (no devices), for the settings editor */
    rawSettings(): Record<string, unknown> {
        const settings: Record<string, unknown> = {};
        for (const key of SETTINGS_KEYS) {
            if (this.raw[key] !== undefined) {
                settings[key] = this.raw[key];
            }
        }
        return settings;
    }

    /** validate a raw device entry; the error names every problem with its path */
    static parseDevice(raw: unknown): DeviceConfig {
        const result = DeviceSchema.safeParse(raw);
        if (!result.success) {
            throw new HttpError(400, 'the device is invalid', {
                issues: result.error.issues.map((issue) => ({
                    level: 'error',
                    path: issue.path.map(String).join('.'),
                    message: issue.message,
                })),
            });
        }
        return result.data;
    }

    static checkKey(key: string): void {
        if (!DEVICE_KEY_PATTERN.test(key)) {
            throw new HttpError(400, 'a device key is 1–64 characters of A–Z a–z 0–9 : . _ -');
        }
    }

    /** store a device raw and return it parsed; the file is written */
    async saveDevice(key: string, raw: unknown): Promise<DeviceConfig> {
        ConfigStore.checkKey(key);
        if (!isRecord(raw)) {
            throw new HttpError(400, 'a device is a JSON object');
        }
        const device = ConfigStore.parseDevice(raw);
        const devices = this.rawDevices;
        devices[key] = structuredClone(raw);
        this.raw.devices = devices;
        await this.write();
        return device;
    }

    async deleteDevice(key: string): Promise<void> {
        const devices = this.rawDevices;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete devices[key];
        this.raw.devices = devices;
        await this.write();
    }

    /** replace the top-level settings; the environment's paths must not change */
    async saveSettings(raw: unknown): Promise<Config> {
        if (!isRecord(raw)) {
            throw new HttpError(400, 'the settings are a JSON object');
        }
        const next: Record<string, unknown> = {...this.raw};
        for (const key of SETTINGS_KEYS) {
            if (raw[key] === undefined) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete next[key];
            } else {
                next[key] = structuredClone(raw[key]);
            }
        }
        const result = ConfigSchema.safeParse({...next, devices: {}});
        if (!result.success) {
            throw new HttpError(400, `the settings are invalid:\n${z.prettifyError(result.error)}`);
        }
        const at = (source: Record<string, unknown>, path: string): unknown => {
            const [a, b] = path.split('.');
            const first = source[a ?? ''];
            return b === undefined ? first : isRecord(first) ? first[b] : undefined;
        };
        for (const path of this.overridden) {
            if (JSON.stringify(at(this.raw, path)) !== JSON.stringify(at(next, path))) {
                throw new HttpError(409, `${path} is set by the environment and cannot be changed here`);
            }
        }
        for (const key of SETTINGS_KEYS) {
            if (next[key] === undefined) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete this.raw[key];
            } else {
                this.raw[key] = next[key];
            }
        }
        await this.write();
        return result.data;
    }

    /** replace every device (an import with `replace`), raw; returns the parsed entries */
    async replaceDevices(raw: Record<string, unknown>): Promise<Map<string, DeviceConfig>> {
        const parsed = new Map<string, DeviceConfig>();
        for (const [key, entry] of Object.entries(raw)) {
            ConfigStore.checkKey(key);
            parsed.set(key, ConfigStore.parseDevice(entry));
        }
        this.raw.devices = structuredClone(raw);
        await this.write();
        return parsed;
    }

    /** write the file atomically: a temporary file next to it, then a rename */
    async write(): Promise<void> {
        const run = async (): Promise<void> => {
            await mkdir(dirname(this.path), {recursive: true});
            const tmp = `${this.path}.${process.pid}.tmp`;
            await writeFile(tmp, `${JSON.stringify(this.raw, null, 2)}\n`, 'utf8');
            await rename(tmp, this.path);
        };
        this.writing = this.writing.then(run, run);
        await this.writing;
    }
}
