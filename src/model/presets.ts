/* Presets: a device template — the endpoints and mappings of a kind of device (a Tasmota relay, a Shelly
   cover, an ESPHome sensor) with placeholders — that becomes a device entry by substituting the user's
   values. The format is fixed here; the shipped presets for Tasmota, Shelly and ESPHome come later and
   users add their own as JSON files. A placeholder is `%name%`; `variables` declares each with a label
   and a default, so an editor can ask for them. Substitution is textual over the JSON of the template,
   so a placeholder can stand in a topic, a payload or a template string alike. A default may itself
   name other variables (`"default": "%item%"`): it is resolved from their values when no value is given,
   so a device's default name can be what identifies it. */

import {z} from 'zod';

import {type DeviceConfig, DeviceSchema} from './schema.ts';

export const PLACEHOLDER_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

export const PresetVariableSchema = z
    .object({
        /** what the editor asks for */
        label: z.string().min(1),
        description: z.string().optional(),
        /** may reference other variables (`%item%`): resolved from their values, then trimmed */
        default: z.string().optional(),
        /** no default and not optional: the user must fill it */
        optional: z.boolean().default(false),
    })
    .strict();
export type PresetVariable = z.infer<typeof PresetVariableSchema>;

export const PresetSchema = z
    .object({
        /** a unique id, e.g. `tasmota/relay` */
        id: z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/, 'a preset id is lower case: tasmota/relay'),
        name: z.string().min(1),
        description: z.string().optional(),
        /** the ecosystem it belongs to, for grouping */
        vendor: z.string().optional(),
        /** the format version; 1 */
        format: z.literal(1).default(1),
        variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), PresetVariableSchema).default({}),
        /** the device entry with placeholders; validated after substitution */
        device: z.unknown(),
    })
    .strict();
export type Preset = z.infer<typeof PresetSchema>;

export class PresetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PresetError';
    }
}

/** the placeholders a preset's device template uses */
export function placeholdersOf(preset: Preset): string[] {
    const names = new Set<string>();
    for (const match of JSON.stringify(preset.device).matchAll(PLACEHOLDER_PATTERN)) {
        const name = match[1];
        if (name !== undefined) {
            names.add(name);
        }
    }
    return [...names].sort();
}

/** the variables a default references */
function referencesOf(text: string): string[] {
    return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

/**
 * parse a preset file's JSON; every placeholder must be declared in `variables`, and a default may reference
 * only declared variables, without a cycle
 */
export function parsePreset(raw: unknown): Preset {
    const result = PresetSchema.safeParse(raw);
    if (!result.success) {
        throw new PresetError(`invalid preset:\n${z.prettifyError(result.error)}`);
    }
    const preset = result.data;
    const undeclared = placeholdersOf(preset).filter((name) => !(name in preset.variables));
    if (undeclared.length > 0) {
        throw new PresetError(`preset ${preset.id}: placeholders without a variable: ${undeclared.join(', ')}`);
    }
    for (const [name, variable] of Object.entries(preset.variables)) {
        const references = referencesOf(variable.default ?? '');
        const unknown = references.filter((ref) => !(ref in preset.variables));
        if (unknown.length > 0) {
            throw new PresetError(
                `preset ${preset.id}: the default of ${name} references undeclared variables: ${unknown.join(', ')}`,
            );
        }
    }
    const cycle = defaultCycle(preset);
    if (cycle !== undefined) {
        throw new PresetError(
            `preset ${preset.id}: the defaults reference each other in a cycle: ${cycle.join(' → ')}`,
        );
    }
    return preset;
}

/** the first cycle among the defaults' references, as the names on it */
function defaultCycle(preset: Preset): string[] | undefined {
    const done = new Set<string>();
    const visit = (name: string, path: string[]): string[] | undefined => {
        const at = path.indexOf(name);
        if (at >= 0) {
            return [...path.slice(at), name];
        }
        if (done.has(name)) {
            return undefined;
        }
        for (const ref of referencesOf(preset.variables[name]?.default ?? '')) {
            const found = visit(ref, [...path, name]);
            if (found !== undefined) {
                return found;
            }
        }
        done.add(name);
        return undefined;
    };
    for (const name of Object.keys(preset.variables)) {
        const found = visit(name, []);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}

/**
 * The value of every variable: the given one, else its default with the references to other variables
 * resolved the same way and the result trimmed, else empty for an optional one. A variable without a value,
 * a default or `optional` is missing.
 */
export function presetValues(preset: Preset, values: Record<string, string>): Record<string, string> {
    const missing: string[] = [];
    const resolved = new Map<string, string>();
    const resolve = (name: string): string => {
        const known = resolved.get(name);
        if (known !== undefined) {
            return known;
        }
        const variable = preset.variables[name];
        const given = values[name];
        let value: string;
        if (given !== undefined) {
            value = given;
        } else if (variable?.default !== undefined) {
            value = variable.default.replace(PLACEHOLDER_PATTERN, (_m, ref: string) => resolve(ref)).trim();
        } else {
            if (variable !== undefined && !variable.optional) {
                missing.push(name);
            }
            value = '';
        }
        resolved.set(name, value);
        return value;
    };
    const filled = Object.fromEntries(Object.keys(preset.variables).map((name) => [name, resolve(name)]));
    if (missing.length > 0) {
        throw new PresetError(`preset ${preset.id}: missing values for ${missing.join(', ')}`);
    }
    return filled;
}

function escapeForJson(value: string): string {
    return JSON.stringify(value).slice(1, -1);
}

/**
 * The device entry a preset yields for the user's values. Values are substituted into the JSON text, so
 * they are escaped as JSON strings; a placeholder that forms a whole JSON string stays a string.
 */
export function applyPreset(preset: Preset, values: Record<string, string>): DeviceConfig {
    const filled = presetValues(preset, values);
    const text = JSON.stringify(preset.device).replace(PLACEHOLDER_PATTERN, (_m, name: string) =>
        escapeForJson(filled[name] ?? ''),
    );
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new PresetError(
            `preset ${preset.id}: the substituted device is not valid JSON: ${(error as Error).message}`,
        );
    }
    const parsed = DeviceSchema.safeParse(raw);
    if (!parsed.success) {
        throw new PresetError(`preset ${preset.id}: the device is invalid:\n${z.prettifyError(parsed.error)}`);
    }
    const device = parsed.data;
    return {...device, source: {kind: 'preset', key: preset.id, version: String(preset.format)}};
}
