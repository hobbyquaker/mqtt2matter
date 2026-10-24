/* Family options: the knobs of the state machines in src/families, one object per family under an
   endpoint's `options`. They are part of the model (pure zod, no matter.js) so the config validates
   without the families and the UI can render a form from them. Every field has a default. */

import {z} from 'zod';

export const OnOffOptionsSchema = z
    .object({
        /** ms: a stateless trigger (a scene, a Home Assistant button): `on` publishes the command and the endpoint
         *  falls back to off after this long; `off` publishes nothing. 0 = an ordinary on/off */
        momentary: z.number().int().min(0).max(60_000).default(0),
    })
    .strict();
export type OnOffOptions = z.infer<typeof OnOffOptionsSchema>;

export const LightOptionsSchema = z
    .object({
        /** HA's `on_command_type`: `first` publishes on, then the level; `last` the level, then on; `brightness`
         *  only the level (the device turns on by itself) */
        onCommandType: z.enum(['first', 'last', 'brightness']).default('last'),
        /** pass a controller's transition time to the command templates as `transition` (seconds) */
        transition: z.boolean().default(true),
        /** the device's colour temperature range in mireds (the attribute's physical min/max) */
        minMireds: z.number().int().min(1).max(65279).default(153),
        maxMireds: z.number().int().min(1).max(65279).default(500),
    })
    .strict();
export type LightOptions = z.infer<typeof LightOptionsSchema>;

export const CoverOptionsSchema = z
    .object({
        /** hold back a position report that merely echoes the previous position right after a command until a
         *  second report corroborates it or `reportTimeout` passes (the FYRTUR target echo) */
        echoFilter: z.boolean().default(false),
        /** seconds after the last position report before a movement counts as stopped */
        reportTimeout: z.number().positive().default(30),
        /** percent100ths within which current and target count as equal */
        tolerance: z.number().int().min(0).max(10000).default(100),
    })
    .strict();
export type CoverOptions = z.infer<typeof CoverOptionsSchema>;

export const ClimateOptionsSchema = z
    .object({
        /** setpoint limits in °C */
        minHeat: z.number().default(7),
        maxHeat: z.number().default(30),
        minCool: z.number().default(16),
        maxCool: z.number().default(32),
        /** °C between heating and cooling setpoint in auto mode */
        deadband: z.number().min(0).max(12.7).default(2),
    })
    .strict();
export type ClimateOptions = z.infer<typeof ClimateOptionsSchema>;

export const FanOptionsSchema = z
    .object({
        /** percent thresholds that turn a percent into low / medium / high when only a percent is bound */
        low: z.number().int().min(1).max(100).default(33),
        medium: z.number().int().min(1).max(100).default(66),
        /** the device's discrete speeds (the MultiSpeed feature); 0 = none */
        speedMax: z.number().int().min(0).max(100).default(0),
    })
    .strict();
export type FanOptions = z.infer<typeof FanOptionsSchema>;

export const SwitchOptionsSchema = z
    .object({
        /** `momentary` (buttons: press kinds → events) or `latching` (a toggle: the value is the position) */
        kind: z.enum(['momentary', 'latching']).default('momentary'),
        numberOfPositions: z.number().int().min(2).max(255).default(2),
        /** presses in one sequence the controller is told about (MultiPress); 1 = single presses only */
        multiPressMax: z.number().int().min(1).max(255).default(3),
        /** ms the family waits for a further press before it completes a sequence (multiPressDelay) */
        multiPressDelay: z.number().int().min(50).max(5000).default(300),
        /** ms a press lasts before it is a long press (longPressDelay) */
        longPressDelay: z.number().int().min(50).max(10000).default(500),
        /** ms between the press and the release the family emits for a complete press kind */
        pressDuration: z.number().int().min(10).max(2000).default(50),
    })
    .strict();
export type SwitchOptions = z.infer<typeof SwitchOptionsSchema>;

export const PowerSourceOptionsSchema = z
    .object({
        /** percent at or below which `batChargeLevel` is Warning / Critical when it is not bound itself */
        warning: z.number().int().min(0).max(100).default(20),
        critical: z.number().int().min(0).max(100).default(10),
    })
    .strict();
export type PowerSourceOptions = z.infer<typeof PowerSourceOptionsSchema>;

export const OptionsSchema = z
    .object({
        onOff: OnOffOptionsSchema.prefault({}),
        light: LightOptionsSchema.prefault({}),
        cover: CoverOptionsSchema.prefault({}),
        climate: ClimateOptionsSchema.prefault({}),
        fan: FanOptionsSchema.prefault({}),
        switch: SwitchOptionsSchema.prefault({}),
        powerSource: PowerSourceOptionsSchema.prefault({}),
    })
    .strict();
export type Options = z.infer<typeof OptionsSchema>;
export type OptionsInput = z.input<typeof OptionsSchema>;
