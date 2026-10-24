/* A parsed device written back to the file without its defaults: the editor works on the parsed
   entry (every field present), the file keeps what the user chose. Nothing semantic changes — the
   compact entry parses to the same device. */

import {OptionsSchema} from '../model/options.ts';
import type {CommandHalf, DeviceConfig, EndpointConfig, StatusHalf} from '../model/schema.ts';

const OPTION_DEFAULTS = OptionsSchema.parse({}) as Record<string, Record<string, unknown>>;

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function dropUndefined<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function compactStatus(half: StatusHalf): Record<string, unknown> {
    const out: Record<string, unknown> = {...half};
    if (half.scale?.clamp === true) {
        out.scale = {from: half.scale.from, to: half.scale.to};
    }
    if (half.get?.payload === '') {
        out.get = {topic: half.get.topic};
    }
    return dropUndefined(out);
}

function compactCommand(half: CommandHalf): Record<string, unknown> {
    const out: Record<string, unknown> = {...half};
    if (!half.retain) {
        delete out.retain;
    }
    if (half.qos === 0) {
        delete out.qos;
    }
    if (half.scale?.clamp === true) {
        out.scale = {from: half.scale.from, to: half.scale.to};
    }
    return dropUndefined(out);
}

function compactEndpoint(endpoint: EndpointConfig, first: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {...endpoint};
    if (first && endpoint.id === 'main') {
        delete out.id;
    }
    if (endpoint.mappings.length === 0) {
        delete out.mappings;
    } else {
        out.mappings = endpoint.mappings.map((mapping) => {
            const b: Record<string, unknown> = {...mapping};
            if (mapping.status !== undefined) {
                b.status = compactStatus(mapping.status);
            }
            if (mapping.command !== undefined) {
                b.command = compactCommand(mapping.command);
            }
            return dropUndefined(b);
        });
    }
    if (endpoint.coalesce === 0) {
        delete out.coalesce;
    }
    const options: Record<string, unknown> = {};
    for (const [family, values] of Object.entries(endpoint.options as Record<string, Record<string, unknown>>)) {
        const defaults = OPTION_DEFAULTS[family] ?? {};
        const kept = Object.fromEntries(Object.entries(values).filter(([k, v]) => !same(v, defaults[k])));
        if (Object.keys(kept).length > 0) {
            options[family] = kept;
        }
    }
    if (Object.keys(options).length === 0) {
        delete out.options;
    } else {
        out.options = options;
    }
    return dropUndefined(out);
}

/** the device entry for the file */
export function compactDevice(device: DeviceConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {...device};
    if (device.enabled) {
        delete out.enabled;
    }
    if (same(device.source, {kind: 'manual'})) {
        delete out.source;
    } else {
        out.source = dropUndefined({...device.source, orphaned: device.source.orphaned === true ? true : undefined});
    }
    if (device.availability !== undefined) {
        const topics = device.availability.topics.map((t) => {
            const topic: Record<string, unknown> = {...t};
            if (t.online === 'online') {
                delete topic.online;
            }
            if (t.offline === 'offline') {
                delete topic.offline;
            }
            return dropUndefined(topic);
        });
        out.availability =
            topics.length === 1 && device.availability.mode === 'latest'
                ? topics[0]
                : {mode: device.availability.mode, topics};
    }
    out.endpoints = device.endpoints.map((endpoint, index) => compactEndpoint(endpoint, index === 0));
    return dropUndefined(out);
}
