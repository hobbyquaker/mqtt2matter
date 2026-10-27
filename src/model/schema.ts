/* The manual model: what a user (or an importer) writes to describe one Matter device and how its
   attributes map onto MQTT. This file is the schema of `config.devices`; docs/config.md describes it
   in prose and is the contract the importers and the UI build on. Objects are strict: a misspelt key is
   an error, not a silently ignored option. The shape: device = bridged node with endpoints; endpoint =
   device type names + cluster features + family options; mapping = one attribute, command or event ↔
   MQTT with independent `status` (device → Matter) and `command` (Matter → device) halves. */

import {z} from 'zod';

import {OptionsSchema} from './options.ts';

/** a device key: the stable Matter endpoint id, so Matter endpoint numbers stay stable across restarts */
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** `Cluster.attribute` in matter.js' names, e.g. `OnOff.onOff`, `LevelControl.currentLevel` */
export const ATTRIBUTE_PATTERN = /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;

/** `Cluster.command` in matter.js' names, e.g. `WindowCovering.stopMotion`, `Identify.identify` */
export const COMMAND_PATTERN = ATTRIBUTE_PATTERN;

/** an event channel a family owns; 1.0 knows `Switch` (press kinds → GenericSwitch events) */
export const EVENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

export const ScalarSchema = z.union([z.boolean(), z.number(), z.string()]);
export type Scalar = z.infer<typeof ScalarSchema>;

export const ValueTypeSchema = z.enum(['boolean', 'number', 'string']);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/** the named conversions between a device's unit and the Matter attribute's unit (docs/config.md) */
export const UnitSchema = z.enum([
    /** °C → Matter 0.01 °C (temperatures, setpoints) */
    'celsius',
    /** °F → Matter 0.01 °C */
    'fahrenheit',
    /** kelvin → mireds (colour temperature) */
    'kelvin',
    /** 0–100 % → Matter 0–10000 (humidity, covers) */
    'percent100ths',
    /** 0–100 % → Matter 0–200 (battery percentage) */
    'halfPercent',
    /** 0–100 % → Matter level 1–254 (brightness) */
    'percentLevel',
    /** 0–255 → Matter level 1–254 (brightness as HA sends it) */
    'byteLevel',
    /** lux → Matter illuminance (10000·log10(lux) + 1) */
    'lux',
    /** volt → millivolt (battery voltage) */
    'volt',
    /** 0–360° → Matter hue 0–254 */
    'degrees254',
    /** 0–100 % → Matter saturation 0–254 */
    'percent254',
    /** seconds → Matter tenths of a second (transition times) */
    'seconds10ths',
]);
export type Unit = z.infer<typeof UnitSchema>;

export const ScaleSchema = z
    .object({
        /** the device's range */
        from: z.tuple([z.number(), z.number()]),
        /** the attribute's range; reversed bounds invert */
        to: z.tuple([z.number(), z.number()]),
        /** clamp into the target range; default true */
        clamp: z.boolean().default(true),
    })
    .strict();
export type Scale = z.infer<typeof ScaleSchema>;

/** the numeric steps both halves share, applied in the order listed on the way in and inverted on the way out */
const NumericSteps = {
    /** a named conversion into the attribute's unit (status) or out of it (command) */
    unit: UnitSchema.optional(),
    /** linear range mapping with clamp */
    scale: ScaleSchema.optional(),
    /** added after scaling (status), subtracted before (command) */
    offset: z.number().optional(),
    /** booleans: not; numbers: mirrored within `scale.from` (status) / `scale.to` (command) */
    invert: z.boolean().optional(),
    /** decimals to round to; integer attributes are rounded to 0 decimals in any case */
    round: z.number().int().min(0).max(10).optional(),
};

export const CodecSchema = z
    .object({
        /** a JavaScript module exporting `decode(payload, context)` and/or `encode(value, context)` */
        module: z.string().min(1),
        /** anything the module wants to know (passed as `context.options`) */
        options: z.unknown().optional(),
    })
    .strict();
export type CodecRef = z.infer<typeof CodecSchema>;

/** a get request published at start and after a reconnect so the device reports its state (z2m `/get`) */
export const GetSchema = z
    .object({
        topic: z.string().min(1),
        payload: z.string().default(''),
    })
    .strict();

/** device → Matter: how a payload on `topic` becomes the attribute's value */
export const StatusHalfSchema = z
    .object({
        topic: z.string().min(1),
        /** a JSON path into the payload (`$.POWER`, `state.on`, `$.a[0]`); absent = the whole payload */
        extract: z.string().min(1).optional(),
        /** a Jinja template over `value` (the extracted value or the payload text) and `value_json` */
        template: z.string().optional(),
        /** the payload's type when there is no map; no guessing: a payload that does not parse is ignored */
        type: ValueTypeSchema.optional(),
        /**
         * extracted value (as text) → attribute value; an unmapped value is ignored unless `default` is set. `null`
         * clears a nullable attribute (`FanControl.percentSetting` while the fan runs in Auto)
         */
        map: z.record(z.string(), ScalarSchema.nullable()).optional(),
        /** the value for an unmapped key (`null` as in `map`) */
        default: ScalarSchema.nullable().optional(),
        ...NumericSteps,
        /** seconds without a message on this topic after which the device is unreachable */
        expire: z.number().positive().optional(),
        get: GetSchema.optional(),
        /** the escape hatch: replaces every step above */
        codec: CodecSchema.optional(),
    })
    .strict();
export type StatusHalf = z.infer<typeof StatusHalfSchema>;

/** Matter → device: how a value a controller wrote becomes a payload on `topic` */
export const CommandHalfSchema = z
    .object({
        topic: z.string().min(1),
        ...NumericSteps,
        /** decimals the number is printed with */
        precision: z.number().int().min(0).max(10).optional(),
        /** attribute value (as text) → payload; absent = the value as text */
        format: z.record(z.string(), z.string()).optional(),
        /** a fixed payload (commands without a value, e.g. `WindowCovering.stopMotion`) */
        payload: z.string().optional(),
        /** a Jinja template over `value` and the family's fields; its result is the payload */
        template: z.string().optional(),
        /** a JSON path: the payload becomes `{a: {b: value}}` (`$.a.b`), merged by `coalesce` */
        wrap: z.string().min(1).optional(),
        retain: z.boolean().default(false),
        qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
        /** apply the value locally right after publishing; default: only when there is no status half */
        optimistic: z.boolean().optional(),
        codec: CodecSchema.optional(),
    })
    .strict();
export type CommandHalf = z.infer<typeof CommandHalfSchema>;

const MappingBase = {
    status: StatusHalfSchema.optional(),
    command: CommandHalfSchema.optional(),
    /** free text for the user; importers put the source field here */
    comment: z.string().optional(),
};

export const AttributeMappingSchema = z
    .object({
        attribute: z.string().regex(ATTRIBUTE_PATTERN, 'an attribute is written Cluster.attribute, e.g. OnOff.onOff'),
        ...MappingBase,
    })
    .strict();

export const CommandMappingSchema = z
    .object({
        /** a command that is not an attribute write; the command half publishes `payload` or `template` */
        invoke: z
            .string()
            .regex(COMMAND_PATTERN, 'a command is written Cluster.command, e.g. WindowCovering.stopMotion'),
        ...MappingBase,
    })
    .strict();

export const EventMappingSchema = z
    .object({
        /** a family's event channel: `Switch` — the status half yields a press kind */
        event: z.string().regex(EVENT_PATTERN, 'an event channel is a cluster name, e.g. Switch'),
        ...MappingBase,
    })
    .strict();

export const MappingSchema = z
    .union([AttributeMappingSchema, CommandMappingSchema, EventMappingSchema])
    .refine((b) => b.status !== undefined || b.command !== undefined, {
        message: 'a mapping needs a status half, a command half or both',
    });
export type Mapping = z.infer<typeof MappingSchema>;
export type AttributeMapping = z.infer<typeof AttributeMappingSchema>;
export type CommandMapping = z.infer<typeof CommandMappingSchema>;
export type EventMapping = z.infer<typeof EventMappingSchema>;

/** `attribute`, `invoke` or `event` — what the mapping is about */
export function mappingTarget(mapping: Mapping): {kind: 'attribute' | 'invoke' | 'event'; name: string} {
    if ('attribute' in mapping) {
        return {kind: 'attribute', name: mapping.attribute};
    }
    if ('invoke' in mapping) {
        return {kind: 'invoke', name: mapping.invoke};
    }
    return {kind: 'event', name: mapping.event};
}

export const EndpointSchema = z
    .object({
        /** the endpoint's id within the device; `main` is the bridged node itself, others are children */
        id: z.string().regex(DEVICE_KEY_PATTERN).default('main'),
        /** matter.js device type names, e.g. `OnOffPlugInUnit`, `DimmableLight`; the first is the endpoint's type */
        deviceTypes: z.array(z.string().min(1)).min(1),
        /** cluster features to enable on top of the device types' defaults, e.g. `{PowerSource: ['Battery']}` */
        features: z.record(z.string(), z.array(z.string())).optional(),
        /** attribute defaults and fixed values, e.g. `{PowerSource: {description: 'AA'}}` */
        attributes: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        mappings: z.array(MappingSchema).default([]),
        /** family options (light, cover, climate, fan, switch …), see options.ts */
        options: OptionsSchema.prefault({}),
        /** ms: command payloads to one topic within this window are merged into one message */
        coalesce: z.number().int().min(0).max(5000).default(0),
    })
    .strict();
export type EndpointConfig = z.infer<typeof EndpointSchema>;

export const SourceSchema = z
    .object({
        kind: z.enum(['manual', 'z2m', 'ha-discovery', 'preset']),
        key: z.string().optional(),
        version: z.string().optional(),
        raw: z.unknown().optional(),
        /** the discovered description disappeared; the device stays until removed by hand */
        orphaned: z.boolean().optional(),
    })
    .strict();
export type Source = z.infer<typeof SourceSchema>;

export const AvailabilityTopicSchema = z
    .object({
        topic: z.string().min(1),
        /** a JSON path into the payload; absent = the whole payload */
        extract: z.string().min(1).optional(),
        template: z.string().optional(),
        online: z.string().default('online'),
        offline: z.string().default('offline'),
    })
    .strict();
export type AvailabilityTopic = z.infer<typeof AvailabilityTopicSchema>;

export const AvailabilitySchema = z
    .object({
        topics: z.array(AvailabilityTopicSchema).min(1),
        /** `all`: reachable when every topic says online; `any`: when one does; `latest`: the last message decides */
        mode: z.enum(['all', 'any', 'latest']).default('latest'),
    })
    .strict();
export type Availability = z.infer<typeof AvailabilitySchema>;

/** one topic in short form, or the full object */
export const AvailabilityInputSchema = z.union([
    AvailabilityTopicSchema.transform((topic): Availability => ({topics: [topic], mode: 'latest'})),
    AvailabilitySchema,
]);

export const DeviceSchema = z
    .object({
        name: z.string().min(1).max(32),
        vendor: z.string().max(32).optional(),
        model: z.string().max(32).optional(),
        /** shown as the bridged device's serial number; default: the device key */
        serial: z.string().max(32).optional(),
        enabled: z.boolean().default(true),
        /** the bridge this device lives in; default: assigned once and remembered (matter/shards) */
        bridge: z.string().optional(),
        source: SourceSchema.prefault({kind: 'manual'}),
        availability: AvailabilityInputSchema.optional(),
        endpoints: z.array(EndpointSchema).min(1),
    })
    .strict()
    .refine((d) => new Set(d.endpoints.map((e) => e.id)).size === d.endpoints.length, {
        message: 'endpoint ids within a device must be unique',
        path: ['endpoints'],
    });
export type DeviceConfig = z.infer<typeof DeviceSchema>;
/** a device as written in the file — no defaults filled in; what importers generate and the UI edits */
export type DeviceInput = z.input<typeof DeviceSchema>;
export type EndpointInput = z.input<typeof EndpointSchema>;
export type MappingInput = z.input<typeof MappingSchema>;
export type SourceInput = z.input<typeof SourceSchema>;

export const DevicesSchema = z.record(
    z.string().regex(DEVICE_KEY_PATTERN, 'a device key is 1–64 characters of A–Z a–z 0–9 : . _ -'),
    DeviceSchema,
);
export type Devices = z.infer<typeof DevicesSchema>;
export type DevicesInput = z.input<typeof DevicesSchema>;
