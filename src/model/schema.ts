/* The manual model: what a user (or an importer) writes to describe one Matter device and how its
   attributes map onto MQTT. This file is the schema of `config.devices`; docs/config.md describes it
   in prose. Phase 0 carries the shape — device, endpoints, bindings with independent status and command
   halves — and the few payload steps the first device needs (extract, type, map, format). Phase 1 adds
   the rest of the payload engine, features, family options, events and commands that are not attribute
   writes, and the model-driven validation against @matter/model. Objects are strict: a misspelt key is an
   error, not a silently ignored option. */

import {z} from 'zod';

/** a device key: the stable Matter endpoint id, so Matter endpoint numbers stay stable across restarts */
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** `Cluster.attribute` in matter.js' names, e.g. `OnOff.onOff`, `LevelControl.currentLevel` */
export const ATTRIBUTE_PATTERN = /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;

export const ScalarSchema = z.union([z.boolean(), z.number(), z.string()]);
export type Scalar = z.infer<typeof ScalarSchema>;

export const ValueTypeSchema = z.enum(['boolean', 'number', 'string']);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/** device → Matter: how a payload on `topic` becomes the attribute's value */
export const StatusHalfSchema = z
    .object({
        topic: z.string().min(1),
        /** a JSON path into the payload (`$.POWER`, `state.on`, `$.a[0]`); absent = the whole payload */
        extract: z.string().min(1).optional(),
        /** the payload's type when there is no map; no guessing: a payload that does not parse is ignored */
        type: ValueTypeSchema.optional(),
        /** extracted value (as text) → attribute value; an unmapped value is ignored and logged */
        map: z.record(z.string(), ScalarSchema).optional(),
    })
    .strict();
export type StatusHalf = z.infer<typeof StatusHalfSchema>;

/** Matter → device: how a value a controller wrote becomes a payload on `topic` */
export const CommandHalfSchema = z
    .object({
        topic: z.string().min(1),
        /** attribute value (as text) → payload; absent = the value as text */
        format: z.record(z.string(), z.string()).optional(),
        retain: z.boolean().default(false),
        qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
        /** apply the value locally right after publishing; default: only when there is no status half */
        optimistic: z.boolean().optional(),
    })
    .strict();
export type CommandHalf = z.infer<typeof CommandHalfSchema>;

export const BindingSchema = z
    .object({
        attribute: z.string().regex(ATTRIBUTE_PATTERN, 'an attribute is written Cluster.attribute, e.g. OnOff.onOff'),
        status: StatusHalfSchema.optional(),
        command: CommandHalfSchema.optional(),
    })
    .strict()
    .refine((b) => b.status !== undefined || b.command !== undefined, {
        message: 'a binding needs a status half, a command half or both',
    });
export type Binding = z.infer<typeof BindingSchema>;

export const EndpointSchema = z
    .object({
        /** the endpoint's id within the device; `main` is the bridged node itself, others are children */
        id: z.string().regex(DEVICE_KEY_PATTERN).default('main'),
        /** matter.js device type names, e.g. `OnOffPlugInUnit`, `DimmableLight` */
        deviceTypes: z.array(z.string().min(1)).min(1),
        /** cluster features to enable, e.g. `{LevelControl: ['OnOff', 'Lighting']}` (phase 1) */
        features: z.record(z.string(), z.array(z.string())).optional(),
        bindings: z.array(BindingSchema).default([]),
        /** family options (light, cover, climate …), phase 1 */
        options: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();
export type EndpointConfig = z.infer<typeof EndpointSchema>;

export const SourceSchema = z
    .object({
        kind: z.enum(['manual', 'z2m', 'ha-discovery']),
        key: z.string().optional(),
        version: z.string().optional(),
        raw: z.unknown().optional(),
    })
    .strict();
export type Source = z.infer<typeof SourceSchema>;

export const AvailabilitySchema = z
    .object({
        topic: z.string().min(1),
        online: z.string().default('online'),
        offline: z.string().default('offline'),
    })
    .strict();

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
        availability: AvailabilitySchema.optional(),
        endpoints: z.array(EndpointSchema).min(1),
    })
    .strict();
export type DeviceConfig = z.infer<typeof DeviceSchema>;

export const DevicesSchema = z.record(
    z.string().regex(DEVICE_KEY_PATTERN, 'a device key is 1–64 characters of A–Z a–z 0–9 : . _ -'),
    DeviceSchema,
);
export type Devices = z.infer<typeof DevicesSchema>;
