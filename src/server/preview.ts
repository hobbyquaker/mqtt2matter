/* The mapping editor's live preview: a payload through a status half step by step (extracted →
   templated → mapped → unit → scaled → the attribute's value), and a Matter value through a command
   half (numeric steps → format / template → wrap → the payload). Each stage runs the engine on the
   half cut down to the steps up to that stage, so what is shown is exactly what the engine does. */

import {type TargetShape, decodeStatus, encodeCommand} from '../engine/payload.ts';
import {COMPOSITE_ATTRIBUTES, cluster} from '../model/catalog.ts';
import {CommandHalfSchema, StatusHalfSchema, type CommandHalf, type StatusHalf} from '../model/schema.ts';
import {HttpError} from './http.ts';

export interface Stage {
    step: string;
    ok: boolean;
    /** the value after this stage (a payload text for the command direction) */
    value?: unknown;
    reason?: string;
}

export interface Preview {
    stages: Stage[];
    ok: boolean;
    /** the final value (status: the attribute's value; command: the payload) */
    result?: unknown;
    reason?: string;
}

const STATUS_STAGES: {step: string; keys: (keyof StatusHalf)[]}[] = [
    {step: 'extract', keys: ['extract']},
    {step: 'template', keys: ['template']},
    {step: 'map', keys: ['map', 'default', 'type']},
    {step: 'unit', keys: ['unit']},
    {step: 'scale', keys: ['scale', 'offset', 'invert', 'round']},
];

const COMMAND_STAGES: {step: string; keys: (keyof CommandHalf)[]}[] = [
    {step: 'scale', keys: ['unit', 'scale', 'offset', 'invert', 'round', 'precision']},
    {step: 'format', keys: ['format', 'payload', 'template']},
    {step: 'wrap', keys: ['wrap']},
];

/** the attribute's shape for `Cluster.attribute`, undefined for a composite or an unknown one */
export function shapeFor(attribute: string | undefined): TargetShape | undefined {
    if (attribute === undefined) {
        return undefined;
    }
    if (attribute in COMPOSITE_ATTRIBUTES) {
        return {metatype: 'any'};
    }
    const [clusterName, attributeName] = attribute.split('.');
    const info = clusterName === undefined || attributeName === undefined ? undefined : cluster(clusterName);
    const a = info?.attributes.get(attributeName ?? '');
    if (a === undefined) {
        return undefined;
    }
    return {metatype: a.metatype, nullable: a.nullable, enumMembers: a.enumMembers, bitFields: a.bitFields};
}

function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Partial<T> {
    const out: Partial<T> = {};
    for (const key of keys) {
        if (source[key] !== undefined) {
            out[key] = source[key];
        }
    }
    return out;
}

export function previewStatus(rawHalf: unknown, payload: string, attribute?: string, topic?: string): Preview {
    const parsed = StatusHalfSchema.safeParse(rawHalf);
    if (!parsed.success) {
        throw new HttpError(400, 'the status half is invalid', {issues: parsed.error.issues});
    }
    const half = parsed.data;
    if (half.codec !== undefined) {
        return {stages: [], ok: false, reason: 'a codec cannot be previewed'};
    }
    const target = shapeFor(attribute);
    const stages: Stage[] = [];
    const used: (keyof StatusHalf)[] = ['topic'];
    let failed: string | undefined;
    for (const stage of STATUS_STAGES) {
        used.push(...stage.keys);
        if (!stage.keys.some((key) => half[key] !== undefined)) {
            continue;
        }
        if (failed !== undefined) {
            stages.push({step: stage.step, ok: false, reason: 'not reached'});
            continue;
        }
        const partial = StatusHalfSchema.parse(pick(half, used));
        const result = decodeStatus(partial, payload, undefined, {topic: topic ?? half.topic});
        if (result.ok) {
            stages.push({step: stage.step, ok: true, value: result.value});
        } else {
            failed = result.reason;
            stages.push({step: stage.step, ok: false, reason: result.reason});
        }
    }
    const final = decodeStatus(half, payload, target, {topic: topic ?? half.topic});
    stages.push(
        final.ok
            ? {step: 'attribute', ok: true, value: final.value}
            : {step: 'attribute', ok: false, reason: failed === undefined ? final.reason : 'not reached'},
    );
    return final.ok ? {stages, ok: true, result: final.value} : {stages, ok: false, reason: final.reason};
}

export function previewCommand(
    rawHalf: unknown,
    value: unknown,
    attribute?: string,
    fields: Record<string, unknown> = {},
): Preview {
    const parsed = CommandHalfSchema.safeParse(rawHalf);
    if (!parsed.success) {
        throw new HttpError(400, 'the command half is invalid', {issues: parsed.error.issues});
    }
    const half = parsed.data;
    if (half.codec !== undefined) {
        return {stages: [], ok: false, reason: 'a codec cannot be previewed'};
    }
    const target = shapeFor(attribute);
    const stages: Stage[] = [{step: 'value', ok: true, value}];
    const used: (keyof CommandHalf)[] = ['topic', 'retain', 'qos'];
    for (const stage of COMMAND_STAGES) {
        used.push(...stage.keys);
        if (!stage.keys.some((key) => half[key] !== undefined)) {
            continue;
        }
        try {
            const partial = CommandHalfSchema.parse(pick(half, used));
            const encoded = encodeCommand(partial, value, {target, fields});
            stages.push({step: stage.step, ok: true, value: encoded.payload});
        } catch (error) {
            stages.push({step: stage.step, ok: false, reason: (error as Error).message});
            return {stages, ok: false, reason: (error as Error).message};
        }
    }
    try {
        const encoded = encodeCommand(half, value, {target, fields});
        stages.push({step: 'payload', ok: true, value: encoded.payload});
        return {stages, ok: true, result: encoded.payload};
    } catch (error) {
        stages.push({step: 'payload', ok: false, reason: (error as Error).message});
        return {stages, ok: false, reason: (error as Error).message};
    }
}
