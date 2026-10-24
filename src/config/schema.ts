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
        /** fixed passcode and discriminator; default: random on first start, then kept in storage/commissioning.json */
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

export const AuthConfigSchema = z
    .object({
        /** `none`: open to whoever reaches the port; `password`: a login; `proxy`: a reverse proxy's header */
        mode: z.enum(['none', 'password', 'proxy']).default('none'),
        /** password mode: an scrypt hash (`mqtt2matter --hash-password`, or set from the UI); a plain string
            is hashed at start, with a warning */
        password: z.string().min(1).optional(),
        /** proxy mode: the header the proxy sets to the authenticated user */
        proxyHeader: z
            .string()
            .regex(/^[A-Za-z0-9-]+$/, 'a header name')
            .default('X-Remote-User'),
        /** proxy mode: where the UI's logout goes (the proxy's sign-out) */
        proxyLogoutUrl: z.url().optional(),
        /** password mode: how long a login lasts */
        sessionHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 365)
            .default(24 * 7),
    })
    .strict()
    .refine((auth) => auth.mode !== 'password' || auth.password !== undefined, {
        message: 'password mode needs a password',
        path: ['password'],
    });
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const ServerConfigSchema = z
    .object({
        /** the web UI and its API; off for a headless bridge */
        enabled: z.boolean().default(true),
        host: z.string().min(1).default('0.0.0.0'),
        port: z.number().int().min(0).max(65535).default(8282),
        /** the MQTT subscriptions for the UI's topic tree and live view, on top of the mappings' topics */
        topics: z.array(z.string().min(1)).default(['#']),
        /** who may use the UI and the API; default: everyone who reaches the port */
        auth: AuthConfigSchema.prefault({}),
    })
    .strict();
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const ImportersConfigSchema = z
    .object({
        z2m: z
            .object({
                /** watch zigbee2mqtt's bridge topics and offer its devices on the UI's adopt page */
                enabled: z.boolean().default(true),
                baseTopic: z.string().min(1).default('zigbee2mqtt'),
            })
            .strict()
            .prefault({}),
        ha: z
            .object({
                /** watch Home Assistant MQTT discovery under the prefix and offer its devices on the adopt page */
                enabled: z.boolean().default(true),
                prefix: z.string().min(1).default('homeassistant'),
            })
            .strict()
            .prefault({}),
    })
    .strict();
export type ImportersConfig = z.infer<typeof ImportersConfigSchema>;

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
        server: ServerConfigSchema.prefault({}),
        /** directories with the user's preset files, on top of the shipped ones */
        presets: z.array(z.string().min(1)).default([]),
        importers: ImportersConfigSchema.prefault({}),
    })
    .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
