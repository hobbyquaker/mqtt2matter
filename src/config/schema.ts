/* The configuration file: the MQTT connection, where matter.js keeps its storage, the bridges, and the
   devices of the manual model (src/model). Every field has a default that makes an unconfigured
   installation start: a local broker, `./data`, one bridge on port 5540, no devices. */

import {z} from 'zod';

import {DevicesSchema} from '../model/schema.ts';

export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const MqttConfigSchema = z
    .object({
        /** mqtt://, mqtts://, ws://, wss:// or unix: … as mqtt.js takes it */
        url: z.string().min(1).default('mqtt://localhost:1883'),
        username: z.string().optional(),
        password: z.string().optional(),
        clientId: z.string().min(1).optional(),
    })
    .strict();

export const BridgeConfigSchema = z
    .object({
        /** the name controllers show for the bridge; default: `mqtt2matter <id>` */
        name: z.string().min(1).max(32).optional(),
        port: z.number().int().min(1).max(65535).default(5540),
        /** fixed passcode and discriminator; default: random on first start, then persisted by matter.js */
        passcode: z.number().int().min(1).max(99999998).optional(),
        discriminator: z.number().int().min(0).max(4095).optional(),
        /** devices this bridge takes before the next one is used; 0 = unlimited (multi-bridge is 1.1) */
        maxDevices: z.number().int().min(0).default(0),
    })
    .strict();
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export const LogConfigSchema = z
    .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        /** matter.js' own log level */
        matter: z.enum(['debug', 'info', 'notice', 'warn', 'error', 'fatal']).default('warn'),
    })
    .strict();

export const ConfigSchema = z
    .object({
        mqtt: MqttConfigSchema.prefault({}),
        /** matter.js storage (fabrics, endpoint numbers) and the shard map */
        storage: z.string().min(1).default('./data'),
        log: LogConfigSchema.prefault({}),
        /** the test vendor id; a certified id is the user's business */
        vendorId: z.number().int().min(0).max(0xffff).default(0xfff1),
        /** the first product id; bridge n gets productId + n */
        productId: z.number().int().min(0).max(0xffff).default(0x8000),
        bridges: z
            .record(
                z.string().regex(BRIDGE_ID_PATTERN, 'a bridge id is 1–32 characters of A–Z a–z 0–9 _ -'),
                BridgeConfigSchema,
            )
            .refine((bridges) => Object.keys(bridges).length > 0, {message: 'at least one bridge is needed'})
            .prefault({default: {}}),
        devices: DevicesSchema.prefault({}),
    })
    .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
