/* Home Assistant MQTT discovery → the manual model. All entities of one Home Assistant device (its
   `device.identifiers`) become one Matter device: the primary entity (a light, switch, cover, climate,
   lock, fan, valve) is the node's own endpoint, every other entity a child endpoint, a battery sensor the
   node's power source, event entities and device triggers GenericSwitch buttons. The component → device
   type table is docs/importers.md's. Templates go to the payload engine when it can run them
   (templates.ts); a mapping whose template it cannot run is left out and listed with the template.
   What is generated is the *baseline*; `source.raw` keeps the expanded configs so a user's edits can be
   carried over when a device announces itself again. */

import {createHash} from 'node:crypto';

import type {z} from 'zod';

import type {
    AvailabilitySchema,
    AvailabilityTopicSchema,
    MappingInput,
    CommandHalfSchema,
    DeviceInput,
    EndpointInput,
    OptionsInput,
    StatusHalfSchema,
} from '../../model/index.ts';
import {type Button, multiPressMax, parseAction, parseActions} from '../actions.ts';
import type {Generated} from '../sync.ts';
import {areaTag} from './areas.ts';
import {checkTemplate} from './templates.ts';
import {type DeviceInfo, deviceIdentity, type EntityConfig, type Origin} from './types.ts';

export const SOURCE_KIND = 'ha-discovery';
/** bumped when the generator's output for the same raw description changes */
export const GENERATOR_VERSION = 1;

const MAX_LABEL = 32;
const MAX_KEY = 64;

/** what `source.raw` holds for one entity: the expanded config, trimmed of what the generator does not read */
export interface RawEntity {
    /** the entity's name within the device: the topic's object id, or the component key */
    id: string;
    topic: string;
    component: string;
    config: EntityConfig;
}

export interface RawDevice {
    kind: 'ha';
    prefix: string;
    /** the first identifier or connection of the Home Assistant device */
    identity: string;
    device: DeviceInfo;
    origin?: Origin;
    entities: RawEntity[];
}

export function isRaw(value: unknown): value is RawDevice {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const raw = value as Record<string, unknown>;
    return (
        raw.kind === 'ha' &&
        typeof raw.prefix === 'string' &&
        typeof raw.identity === 'string' &&
        Array.isArray(raw.entities)
    );
}

export function rawHash(raw: RawDevice): string {
    return `${GENERATOR_VERSION}.${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 12)}`;
}

/** a device key the schema accepts: `ha:` plus the identity, cleaned; long ones are cut and hashed */
export function deviceKey(identity: string): string {
    const cleaned = identity.replace(/[^A-Za-z0-9:._-]/g, '_');
    const key = `ha:${cleaned}`;
    if (key.length <= MAX_KEY) {
        return key;
    }
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
    return `${key.slice(0, MAX_KEY - 9)}-${hash}`;
}

/** an endpoint id the schema accepts */
export function endpointId(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, MAX_KEY);
    return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `e${cleaned}`;
}

/** the key of the zigbee2mqtt importer's native description when this device is zigbee2mqtt's own discovery */
export function nativeKey(identity: string, origin: Origin | undefined): string | undefined {
    if (origin?.name !== 'Zigbee2MQTT') {
        return undefined;
    }
    const device = /^zigbee2mqtt_(0x[0-9a-fA-F]{16})$/.exec(identity);
    if (device !== null) {
        return `z2m:${device[1] ?? ''}`;
    }
    const group = /^zigbee2mqtt_\d+_(\d+)$/.exec(identity);
    if (group !== null) {
        return `z2m:group:${group[1] ?? ''}`;
    }
    return undefined;
}

/** config keys the generator never reads: dropped from `source.raw` so the file stays lean and private */
const DROPPED_KEYS = new Set([
    'icon',
    'entity_picture',
    'json_attributes_topic',
    'json_attributes_template',
    'json_attributes',
    'default_entity_id',
    'force_update',
    'migrate_discovery',
    'qos',
    'encoding',
]);

export function trimConfig(config: EntityConfig): EntityConfig {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
        if (DROPPED_KEYS.has(key) || key === 'device' || key === 'origin' || value === undefined) {
            continue;
        }
        out[key] = value;
    }
    return out;
}

export function trimDevice(device: DeviceInfo): DeviceInfo {
    const out: Record<string, unknown> = {};
    for (const key of [
        'identifiers',
        'connections',
        'name',
        'manufacturer',
        'model',
        'model_id',
        'sw_version',
        'hw_version',
        'serial_number',
        'suggested_area',
        'via_device',
    ] as const) {
        if (device[key] !== undefined) {
            out[key] = device[key];
        }
    }
    return out;
}

export function trimOrigin(origin: Origin | undefined): Origin | undefined {
    if (origin === undefined) {
        return undefined;
    }
    const out: Origin = {};
    if (typeof origin.name === 'string') {
        out.name = origin.name;
    }
    if (typeof origin.sw_version === 'string') {
        out.sw_version = origin.sw_version;
    }
    return out;
}

/* ----- the drafts ----- */

type StatusInput = z.input<typeof StatusHalfSchema>;
type CommandInput = z.input<typeof CommandHalfSchema>;
type AvailabilityInput = z.input<typeof AvailabilitySchema> | z.input<typeof AvailabilityTopicSchema>;

interface Draft {
    id: string;
    entity: RawEntity | undefined;
    /** a light, switch, cover, climate, lock, fan or valve: a candidate for the device's own endpoint */
    primary: boolean;
    types: string[];
    mappings: MappingInput[];
    features: Record<string, string[]>;
    attributes: Record<string, Record<string, unknown>>;
    options: OptionsInput;
    coalesce: number;
}

/** the order device types take on an endpoint and the order entities take as the device's own endpoint */
const TYPE_ORDER = [
    'ExtendedColorLight',
    'ColorTemperatureLight',
    'DimmableLight',
    'OnOffLight',
    'WindowCovering',
    'Thermostat',
    'DoorLock',
    'Fan',
    'WaterValve',
    'OnOffPlugInUnit',
    'OccupancySensor',
    'ContactSensor',
    'WaterLeakDetector',
    'WaterFreezeDetector',
    'RainSensor',
    'SmokeCoAlarm',
    'AirQualitySensor',
    'TemperatureSensor',
    'HumiditySensor',
    'PressureSensor',
    'FlowSensor',
    'LightSensor',
    'GenericSwitch',
    'PowerSource',
];
const typeRank = (name: string): number => {
    const i = TYPE_ORDER.indexOf(name);
    return i === -1 ? TYPE_ORDER.length : i;
};

/** the order components are walked: primaries first, so the first draft is the device's own endpoint */
const COMPONENT_ORDER = [
    'light',
    'cover',
    'climate',
    'lock',
    'fan',
    'valve',
    'switch',
    'binary_sensor',
    'sensor',
    'event',
    'device_trigger',
];
const componentRank = (name: string): number => {
    const i = COMPONENT_ORDER.indexOf(name);
    return i === -1 ? COMPONENT_ORDER.length : i;
};

const PRIMARY = new Set(['light', 'switch', 'cover', 'climate', 'lock', 'fan', 'valve']);

/** the Common Number semantic tag namespace (Matter namespaces, 0x07): sibling endpoints of one type */
const NUMBER_NAMESPACE = 7;
/** the Common Area namespace (0x10): the area a device is in */
const AREA_NAMESPACE = 16;

const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
};
const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const label = (value: string | undefined): string | undefined =>
    value === undefined || value === '' ? undefined : value.slice(0, MAX_LABEL);

function entityName(entity: RawEntity): string {
    const name = entity.config.name;
    return typeof name === 'string' && name !== '' ? name : entity.id;
}

class Builder {
    readonly drafts = new Map<string, Draft>();
    readonly unmapped: string[] = [];
    /** the device's power source, merged into the device's own endpoint at the end */
    private power: Draft | undefined;
    private availability: AvailabilityInput | undefined;
    private availabilityFrom: string | undefined;
    /** device triggers accumulate per topic and button */
    private readonly triggers = new Map<string, {topic: string; template: string | undefined; button: Button}>();

    private draft(id: string, entity: RawEntity | undefined, primary = false): Draft {
        let unique = endpointId(id);
        let n = 1;
        while (this.drafts.has(unique) && this.drafts.get(unique)?.entity !== entity) {
            n++;
            unique = `${endpointId(id)}_${n}`;
        }
        let draft = this.drafts.get(unique);
        if (draft === undefined) {
            draft = {
                id: unique,
                entity,
                primary,
                types: [],
                mappings: [],
                features: {},
                attributes: {},
                options: {},
                coalesce: 0,
            };
            this.drafts.set(unique, draft);
        }
        return draft;
    }

    private powerDraft(): Draft {
        this.power ??= {
            id: 'power',
            entity: undefined,
            primary: false,
            types: ['PowerSource'],
            mappings: [],
            features: {},
            attributes: {},
            options: {},
            coalesce: 0,
        };
        return this.power;
    }

    private addType(draft: Draft, type: string): void {
        if (!draft.types.includes(type)) {
            draft.types.push(type);
            draft.types.sort((a, b) => typeRank(a) - typeRank(b));
        }
    }

    private addFeature(draft: Draft, cluster: string, feature: string): void {
        const features = (draft.features[cluster] ??= []);
        if (!features.includes(feature)) {
            features.push(feature);
        }
    }

    private skip(entity: RawEntity, reason: string): void {
        this.unmapped.push(`${entity.component} "${entityName(entity)}": ${reason}`);
    }

    /** a template the engine can run, or undefined (listed) */
    private template(
        entity: RawEntity,
        field: string,
        side: 'status' | 'command',
        extra: readonly string[] = [],
    ): string | undefined {
        const source = entity.config[field];
        if (typeof source !== 'string' || source === '') {
            return undefined;
        }
        const check = checkTemplate(source, side, extra);
        if (!check.ok) {
            this.unmapped.push(`${entity.component} "${entityName(entity)}": ${field} ${check.reason}: ${source}`);
            return `\u0000${source}`;
        }
        return source;
    }

    /** a status half; undefined when the template cannot be run (already listed) or there is no topic */
    private status(
        entity: RawEntity,
        topicField: string,
        templateField: string | undefined,
        extra: Partial<StatusInput> = {},
    ): StatusInput | undefined {
        const topic = str(entity.config[topicField]);
        if (topic === undefined) {
            return undefined;
        }
        const half: StatusInput = {topic, ...extra};
        if (templateField !== undefined) {
            const template = this.template(entity, templateField, 'status');
            if (template?.startsWith('\u0000') === true) {
                return undefined;
            }
            if (template !== undefined) {
                half.template = template;
            }
        }
        const expire = num(entity.config.expire_after);
        if (expire !== undefined && expire > 0) {
            half.expire = expire;
        }
        return half;
    }

    /** a command half; undefined when the template cannot be run (already listed) or there is no topic */
    private command(
        entity: RawEntity,
        topicField: string,
        templateField: string | undefined,
        extra: Partial<CommandInput> = {},
        /** `{% set … %}` lines that give Home Assistant's variables their meaning before the template */
        prelude = '',
        extraVariables: readonly string[] = [],
    ): CommandInput | undefined {
        const topic = str(entity.config[topicField]);
        if (topic === undefined) {
            return undefined;
        }
        const half: CommandInput = {topic, ...extra};
        if (templateField !== undefined) {
            const template = this.template(entity, templateField, 'command', extraVariables);
            if (template?.startsWith('\u0000') === true) {
                return undefined;
            }
            if (template !== undefined) {
                delete half.format;
                half.template = prelude + template;
            }
        }
        if (entity.config.optimistic === true) {
            half.optimistic = true;
        }
        if (entity.config.retain === true) {
            half.retain = true;
        }
        return half;
    }

    private bind(draft: Draft, target: Record<string, unknown>, status?: StatusInput, command?: CommandInput): void {
        if (status === undefined && command === undefined) {
            return;
        }
        draft.mappings.push({
            ...target,
            ...(status === undefined ? {} : {status}),
            ...(command === undefined ? {} : {command}),
        } as MappingInput);
    }

    private takeAvailability(entity: RawEntity): void {
        const c = entity.config;
        const entries = c.availability;
        let availability: AvailabilityInput | undefined;
        if (Array.isArray(entries) && entries.length > 0) {
            const topics = entries.map((entry) => {
                const topic: z.input<typeof AvailabilityTopicSchema> = {topic: entry.topic};
                if (entry.value_template !== undefined) {
                    topic.template = entry.value_template;
                } else if (typeof c.availability_template === 'string') {
                    topic.template = c.availability_template;
                }
                if (entry.payload_available !== undefined) {
                    topic.online = entry.payload_available;
                }
                if (entry.payload_not_available !== undefined) {
                    topic.offline = entry.payload_not_available;
                }
                return topic;
            });
            const mode = c.availability_mode;
            availability =
                topics.length === 1 && mode === undefined
                    ? topics[0]
                    : {topics, mode: mode === 'all' || mode === 'any' ? mode : 'latest'};
        } else if (typeof c.availability_topic === 'string' && c.availability_topic !== '') {
            const topic: z.input<typeof AvailabilityTopicSchema> = {topic: c.availability_topic};
            if (typeof c.availability_template === 'string') {
                topic.template = c.availability_template;
            }
            if (typeof c.payload_available === 'string') {
                topic.online = c.payload_available;
            }
            if (typeof c.payload_not_available === 'string') {
                topic.offline = c.payload_not_available;
            }
            availability = topic;
        }
        if (availability === undefined) {
            return;
        }
        for (const topic of 'topics' in availability ? availability.topics : [availability]) {
            if (topic.template !== undefined && !checkTemplate(topic.template, 'status').ok) {
                delete topic.template;
            }
        }
        // the device takes the availability of its primary entity, else the first entity that has one
        if (this.availability === undefined || (PRIMARY.has(entity.component) && this.availabilityFrom !== 'primary')) {
            this.availability = availability;
            this.availabilityFrom = PRIMARY.has(entity.component) ? 'primary' : 'entity';
        }
    }

    /* ----- the components ----- */

    private onOffMapping(
        entity: RawEntity,
        draft: Draft,
        stateTopic: string,
        stateTemplate: string,
        on: string,
        off: string,
        stateOn = on,
        stateOff = off,
    ): void {
        // lights and fans document `state_value_template`; the older `value_template` is still what Tasmota sends
        const templateField =
            entity.config[stateTemplate] === undefined && typeof entity.config.value_template === 'string'
                ? 'value_template'
                : stateTemplate;
        const status = this.status(entity, stateTopic, templateField, {map: {[stateOn]: true, [stateOff]: false}});
        const command = this.command(
            entity,
            'command_topic',
            'command_template',
            {format: {true: on, false: off}},
            `{% set value = ${JSON.stringify(on)} if value else ${JSON.stringify(off)} %}`,
        );
        this.bind(draft, {attribute: 'OnOff.onOff'}, status, command);
    }

    switch(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'OnOffPlugInUnit');
        const on = text(c.payload_on, 'ON');
        const off = text(c.payload_off, 'OFF');
        this.onOffMapping(
            entity,
            draft,
            'state_topic',
            'value_template',
            on,
            off,
            text(c.state_on, on),
            text(c.state_off, off),
        );
    }

    light(entity: RawEntity): void {
        const c = entity.config;
        const schema = str(c.schema) ?? 'default';
        if (schema === 'json') {
            this.lightJson(entity);
            return;
        }
        if (schema === 'template') {
            this.lightTemplate(entity);
            return;
        }
        const draft = this.draft(entity.id, entity, true);
        const on = text(c.payload_on, 'ON');
        const off = text(c.payload_off, 'OFF');
        const brightness = str(c.brightness_command_topic) !== undefined || str(c.brightness_state_topic) !== undefined;
        const colorTemp = str(c.color_temp_command_topic) !== undefined || str(c.color_temp_state_topic) !== undefined;
        const hs = str(c.hs_command_topic) !== undefined || str(c.hs_state_topic) !== undefined;
        const xy = str(c.xy_command_topic) !== undefined || str(c.xy_state_topic) !== undefined;
        const rgb = str(c.rgb_command_topic) !== undefined || str(c.rgb_state_topic) !== undefined;
        this.addType(
            draft,
            hs || xy || rgb
                ? 'ExtendedColorLight'
                : colorTemp
                  ? 'ColorTemperatureLight'
                  : brightness
                    ? 'DimmableLight'
                    : 'OnOffLight',
        );
        this.lightOptions(draft, c);
        this.onOffMapping(entity, draft, 'state_topic', 'state_value_template', on, off);
        if (brightness) {
            const scale = num(c.brightness_scale) ?? 255;
            const steps = {scale: {from: [1, scale] as [number, number], to: [1, 254] as [number, number]}};
            this.bind(
                draft,
                {attribute: 'LevelControl.currentLevel'},
                this.status(entity, 'brightness_state_topic', 'brightness_value_template', {...steps, type: 'number'}),
                this.command(entity, 'brightness_command_topic', 'brightness_command_template', {...steps, round: 0}),
            );
        }
        if (colorTemp) {
            const kelvin = c.color_temp_kelvin === true;
            const unit = kelvin ? {unit: 'kelvin' as const} : {};
            this.bind(
                draft,
                {attribute: 'ColorControl.colorTemperatureMireds'},
                this.status(entity, 'color_temp_state_topic', 'color_temp_value_template', {...unit, type: 'number'}),
                this.command(entity, 'color_temp_command_topic', 'color_temp_command_template', {...unit, round: 0}),
            );
        }
        if (xy) {
            this.bind(
                draft,
                {attribute: 'ColorControl.colorXy'},
                this.status(entity, 'xy_state_topic', 'xy_value_template'),
                this.command(entity, 'xy_command_topic', 'xy_command_template', {template: '{{ x }},{{ y }}'}),
            );
        }
        if (hs) {
            if (xy) {
                this.addFeature(draft, 'ColorControl', 'HueSaturation');
            }
            this.bind(
                draft,
                {attribute: 'ColorControl.colorHs'},
                this.status(entity, 'hs_state_topic', 'hs_value_template'),
                this.command(entity, 'hs_command_topic', 'hs_command_template', {
                    template: '{{ hue }},{{ saturation }}',
                }),
            );
        }
        if (rgb) {
            this.bind(
                draft,
                {attribute: 'ColorControl.colorRgb'},
                this.status(entity, 'rgb_state_topic', 'rgb_value_template'),
                this.command(entity, 'rgb_command_topic', 'rgb_command_template', {
                    template: '{{ red }},{{ green }},{{ blue }}',
                }),
            );
        }
        if ((hs || xy || rgb) && colorTemp) {
            this.colorMode(entity, draft, 'color_mode_state_topic', 'color_mode_value_template', hs && !xy);
        }
        for (const [field, what] of [
            ['rgbw_command_topic', 'RGBW white channel'],
            ['rgbww_command_topic', 'RGBWW white channels'],
            ['white_command_topic', 'white mode'],
            ['effect_command_topic', 'effects'],
        ] as const) {
            if (str(c[field]) !== undefined) {
                this.skip(entity, `${what} have no Matter equivalent`);
            }
        }
    }

    private lightOptions(draft: Draft, c: EntityConfig): void {
        const light = (draft.options.light ??= {});
        const onCommandType = str(c.on_command_type);
        if (onCommandType === 'first' || onCommandType === 'last' || onCommandType === 'brightness') {
            light.onCommandType = onCommandType;
        }
        const maxKelvin = num(c.max_kelvin);
        const minKelvin = num(c.min_kelvin);
        const minMireds =
            num(c.min_mireds) ?? (maxKelvin === undefined || maxKelvin <= 0 ? undefined : 1e6 / maxKelvin);
        const maxMireds =
            num(c.max_mireds) ?? (minKelvin === undefined || minKelvin <= 0 ? undefined : 1e6 / minKelvin);
        if (minMireds !== undefined) {
            light.minMireds = Math.max(1, Math.round(minMireds));
        }
        if (maxMireds !== undefined) {
            light.maxMireds = Math.min(65279, Math.round(maxMireds));
        }
        if (Object.keys(light).length === 0) {
            delete draft.options.light;
        }
    }

    private colorMode(
        entity: RawEntity,
        draft: Draft,
        topicField: string,
        templateField: string,
        hsOnly: boolean,
    ): void {
        const colour = hsOnly ? 'CurrentHueAndCurrentSaturation' : 'CurrentXAndCurrentY';
        const status = this.status(entity, topicField, templateField, {
            map: {
                xy: 'CurrentXAndCurrentY',
                hs: 'CurrentHueAndCurrentSaturation',
                rgb: colour,
                rgbw: colour,
                rgbww: colour,
                color_temp: 'ColorTemperatureMireds',
            },
        });
        this.bind(draft, {attribute: 'ColorControl.colorMode'}, status);
    }

    private lightJson(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        const modes = new Set(list(c.supported_color_modes));
        const brightness = c.brightness === true || modes.has('brightness');
        const colorTemp = modes.has('color_temp');
        const xy = modes.has('xy');
        const hs = modes.has('hs');
        const rgb = modes.has('rgb') || modes.has('rgbw') || modes.has('rgbww');
        this.addType(
            draft,
            xy || hs || rgb
                ? 'ExtendedColorLight'
                : colorTemp
                  ? 'ColorTemperatureLight'
                  : brightness
                    ? 'DimmableLight'
                    : 'OnOffLight',
        );
        this.lightOptions(draft, c);
        draft.coalesce = 50;
        const state = str(c.state_topic);
        const command = str(c.command_topic);
        const status = (extract: string, extra: Partial<StatusInput> = {}): StatusInput | undefined => {
            if (state === undefined) {
                return undefined;
            }
            const half: StatusInput = {topic: state, extract, ...extra};
            const expire = num(c.expire_after);
            if (expire !== undefined && expire > 0) {
                half.expire = expire;
            }
            return half;
        };
        const cmd = (extra: Partial<CommandInput>): CommandInput | undefined =>
            command === undefined
                ? undefined
                : {topic: command, ...extra, ...(c.retain === true ? {retain: true} : {})};
        this.bind(
            draft,
            {attribute: 'OnOff.onOff'},
            status('state', {map: {ON: true, OFF: false}}),
            cmd({wrap: 'state', format: {true: 'ON', false: 'OFF'}}),
        );
        if (brightness) {
            const scale = num(c.brightness_scale) ?? 255;
            const steps = {scale: {from: [1, scale] as [number, number], to: [1, 254] as [number, number]}};
            this.bind(
                draft,
                {attribute: 'LevelControl.currentLevel'},
                status('brightness', {...steps, type: 'number'}),
                cmd({wrap: 'brightness', ...steps, round: 0}),
            );
        }
        if (colorTemp) {
            const unit = c.color_temp_kelvin === true ? {unit: 'kelvin' as const} : {};
            this.bind(
                draft,
                {attribute: 'ColorControl.colorTemperatureMireds'},
                status('color_temp', {...unit, type: 'number'}),
                cmd({wrap: 'color_temp', ...unit, round: 0}),
            );
        }
        if (xy) {
            this.bind(draft, {attribute: 'ColorControl.colorXy'}, status('color'), cmd({wrap: 'color'}));
            if (hs) {
                this.addFeature(draft, 'ColorControl', 'HueSaturation');
            }
        } else if (hs) {
            this.bind(
                draft,
                {attribute: 'ColorControl.colorHs'},
                status('color'),
                cmd({template: '{"state": "ON", "color": {"h": {{ hue }}, "s": {{ saturation }}}}'}),
            );
        } else if (rgb) {
            this.bind(
                draft,
                {attribute: 'ColorControl.colorRgb'},
                status('color'),
                cmd({template: '{"state": "ON", "color": {"r": {{ red }}, "g": {{ green }}, "b": {{ blue }}}}'}),
            );
        }
        if ((xy || hs || rgb) && colorTemp) {
            const colour = hs && !xy ? 'CurrentHueAndCurrentSaturation' : 'CurrentXAndCurrentY';
            this.bind(
                draft,
                {attribute: 'ColorControl.colorMode'},
                status('color_mode', {
                    map: {
                        xy: 'CurrentXAndCurrentY',
                        hs: 'CurrentHueAndCurrentSaturation',
                        rgb: colour,
                        rgbw: colour,
                        rgbww: colour,
                        color_temp: 'ColorTemperatureMireds',
                    },
                }),
            );
        }
        if (modes.has('rgbw') || modes.has('rgbww') || modes.has('white')) {
            this.skip(entity, 'white channels have no Matter equivalent');
        }
        if (c.effect === true) {
            this.skip(entity, 'effects have no Matter equivalent');
        }
    }

    private lightTemplate(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        const brightness = str(c.brightness_template) !== undefined;
        const colorTemp = str(c.color_temp_template) !== undefined;
        this.addType(draft, colorTemp ? 'ColorTemperatureLight' : brightness ? 'DimmableLight' : 'OnOffLight');
        this.lightOptions(draft, c);
        const on = this.template(entity, 'command_on_template', 'command');
        const off = this.template(entity, 'command_off_template', 'command');
        const usable = (t: string | undefined): string | undefined =>
            t?.startsWith('\u0000') === true ? undefined : t;
        const onTemplate = usable(on);
        const offTemplate = usable(off);
        const command = str(c.command_topic);
        const onOffCommand: CommandInput | undefined =
            command !== undefined && onTemplate !== undefined && offTemplate !== undefined
                ? {topic: command, template: `{% if value %}${onTemplate}{% else %}${offTemplate}{% endif %}`}
                : undefined;
        this.bind(
            draft,
            {attribute: 'OnOff.onOff', comment: 'command_on_template / command_off_template'},
            this.status(entity, 'state_topic', 'state_template', {map: {on: true, off: false}}),
            onOffCommand,
        );
        if (brightness) {
            const steps = {scale: {from: [1, 255] as [number, number], to: [1, 254] as [number, number]}};
            this.bind(
                draft,
                {attribute: 'LevelControl.currentLevel', comment: 'command_on_template'},
                this.status(entity, 'state_topic', 'brightness_template', {...steps, type: 'number'}),
                command !== undefined && onTemplate !== undefined
                    ? {topic: command, template: onTemplate, ...steps, round: 0}
                    : undefined,
            );
        }
        if (colorTemp) {
            this.bind(
                draft,
                {attribute: 'ColorControl.colorTemperatureMireds', comment: 'command_on_template'},
                this.status(entity, 'state_topic', 'color_temp_template', {type: 'number'}),
                command !== undefined && onTemplate !== undefined
                    ? {topic: command, template: onTemplate, round: 0}
                    : undefined,
            );
        }
        if (str(c.red_template) !== undefined || str(c.hue_template) !== undefined) {
            this.skip(entity, 'colour through separate templates is not mapped');
        }
    }

    cover(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'WindowCovering');
        const positionOpen = num(c.position_open) ?? 100;
        const positionClosed = num(c.position_closed) ?? 0;
        // Home Assistant counts position_open (100) = open; Matter 0 = open
        const scale = {from: [positionClosed, positionOpen] as [number, number], to: [10000, 0] as [number, number]};
        const positionAware = str(c.position_topic) !== undefined;
        if (positionAware) {
            this.bind(
                draft,
                {attribute: 'WindowCovering.currentPositionLiftPercent100ths'},
                this.status(entity, 'position_topic', 'position_template', {scale, type: 'number'}),
            );
        }
        if (str(c.set_position_topic) !== undefined) {
            this.bind(
                draft,
                {attribute: 'WindowCovering.targetPositionLiftPercent100ths'},
                undefined,
                this.command(
                    entity,
                    'set_position_topic',
                    'set_position_template',
                    {scale, round: 0},
                    '{% set position = open %}',
                    ['position'],
                ),
            );
        }
        const stateTopic = str(c.state_topic);
        if (stateTopic !== undefined) {
            const map: Record<string, string> = {};
            const put = (field: string, fallback: string, kind: string): void => {
                map[text(c[field], fallback)] = kind;
            };
            put('state_opening', 'opening', 'opening');
            put('state_closing', 'closing', 'closing');
            put('state_stopped', 'stopped', 'stopped');
            if (!positionAware) {
                put('state_open', 'open', 'open');
                put('state_closed', 'closed', 'closed');
            }
            this.bind(
                draft,
                {attribute: 'WindowCovering.motion'},
                this.status(entity, 'state_topic', 'value_template', {map}),
            );
        }
        const command = str(c.command_topic);
        if (command !== undefined) {
            const open = c.payload_open === null ? undefined : text(c.payload_open, 'OPEN');
            const close = c.payload_close === null ? undefined : text(c.payload_close, 'CLOSE');
            const stop = c.payload_stop === null ? undefined : text(c.payload_stop, 'STOP');
            if (!positionAware || str(c.set_position_topic) === undefined) {
                if (open !== undefined) {
                    this.bind(draft, {invoke: 'WindowCovering.upOrOpen'}, undefined, {topic: command, payload: open});
                }
                if (close !== undefined) {
                    this.bind(draft, {invoke: 'WindowCovering.downOrClose'}, undefined, {
                        topic: command,
                        payload: close,
                    });
                }
            }
            if (stop !== undefined) {
                this.bind(draft, {invoke: 'WindowCovering.stopMotion'}, undefined, {topic: command, payload: stop});
            }
        }
        if (str(c.tilt_status_topic) !== undefined || str(c.tilt_command_topic) !== undefined) {
            const tiltMin = num(c.tilt_min) ?? 0;
            const tiltMax = num(c.tilt_max) ?? 100;
            const closed = num(c.tilt_closed_value) ?? tiltMin;
            const opened = num(c.tilt_opened_value) ?? tiltMax;
            const tilt = {from: [closed, opened] as [number, number], to: [10000, 0] as [number, number]};
            this.bind(
                draft,
                {attribute: 'WindowCovering.currentPositionTiltPercent100ths'},
                this.status(entity, 'tilt_status_topic', 'tilt_status_template', {scale: tilt, type: 'number'}),
            );
            this.bind(
                draft,
                {attribute: 'WindowCovering.targetPositionTiltPercent100ths'},
                undefined,
                this.command(
                    entity,
                    'tilt_command_topic',
                    'tilt_command_template',
                    {scale: tilt, round: 0},
                    '{% set tilt_position = open %}',
                    ['tilt_position'],
                ),
            );
        }
        const deviceClass = str(c.device_class);
        if (deviceClass === 'garage' || deviceClass === 'gate' || deviceClass === 'door') {
            this.unmapped.push(
                `${entity.component} "${entityName(entity)}": device_class ${deviceClass} is shown as a window covering`,
            );
        }
    }

    climate(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'Thermostat');
        draft.coalesce = 50;
        const unit = str(c.temperature_unit) === 'F' ? ('fahrenheit' as const) : ('celsius' as const);
        const climate = (draft.options.climate ??= {});
        const modes = list(c.modes).length > 0 ? list(c.modes) : ['auto', 'off', 'cool', 'heat', 'dry', 'fan_only'];
        const heat = modes.includes('heat') || modes.includes('auto') || modes.includes('heat_cool');
        const cool = modes.includes('cool') || modes.includes('auto') || modes.includes('heat_cool');
        this.bind(
            draft,
            {attribute: 'Thermostat.localTemperature'},
            this.status(entity, 'current_temperature_topic', 'current_temperature_template', {unit, type: 'number'}),
        );
        const minTemp = num(c.min_temp);
        const maxTemp = num(c.max_temp);
        const ranged =
            str(c.temperature_low_command_topic) !== undefined || str(c.temperature_high_command_topic) !== undefined;
        if (heat || !cool) {
            this.bind(
                draft,
                {attribute: 'Thermostat.occupiedHeatingSetpoint'},
                this.status(
                    entity,
                    ranged ? 'temperature_low_state_topic' : 'temperature_state_topic',
                    ranged ? 'temperature_low_state_template' : 'temperature_state_template',
                    {unit, type: 'number'},
                ),
                this.command(
                    entity,
                    ranged ? 'temperature_low_command_topic' : 'temperature_command_topic',
                    ranged ? 'temperature_low_command_template' : 'temperature_command_template',
                    {unit, round: 1},
                ),
            );
            if (minTemp !== undefined) {
                climate.minHeat = minTemp;
            }
            if (maxTemp !== undefined) {
                climate.maxHeat = maxTemp;
            }
        }
        if (cool) {
            this.bind(
                draft,
                {attribute: 'Thermostat.occupiedCoolingSetpoint'},
                this.status(
                    entity,
                    ranged ? 'temperature_high_state_topic' : 'temperature_state_topic',
                    ranged ? 'temperature_high_state_template' : 'temperature_state_template',
                    {unit, type: 'number'},
                ),
                this.command(
                    entity,
                    ranged ? 'temperature_high_command_topic' : 'temperature_command_topic',
                    ranged ? 'temperature_high_command_template' : 'temperature_command_template',
                    {unit, round: 1},
                ),
            );
            if (minTemp !== undefined) {
                climate.minCool = minTemp;
            }
            if (maxTemp !== undefined) {
                climate.maxCool = maxTemp;
            }
        }
        const names: Record<string, string> = {
            off: 'Off',
            heat: 'Heat',
            cool: 'Cool',
            auto: 'Auto',
            heat_cool: 'Auto',
            dry: 'Dry',
            fan_only: 'FanOnly',
        };
        const map: Record<string, string> = {};
        const format: Record<string, string> = {};
        const sets: string[] = [];
        for (const mode of modes) {
            const name = names[mode];
            if (name !== undefined) {
                map[mode] = name;
                format[name] ??= mode;
            }
        }
        for (const [name, mode] of Object.entries(format)) {
            sets.push(`${JSON.stringify(mode)} if name == ${JSON.stringify(name)}`);
        }
        this.bind(
            draft,
            {attribute: 'Thermostat.systemMode'},
            this.status(entity, 'mode_state_topic', 'mode_state_template', {map}),
            this.command(
                entity,
                'mode_command_topic',
                'mode_command_template',
                {format},
                `{% set value = ${sets.join(' else ')} else name | lower %}`,
            ),
        );
        this.bind(
            draft,
            {attribute: 'Thermostat.thermostatRunningState'},
            this.status(entity, 'action_topic', 'action_template', {
                map: {heating: 'heat', cooling: 'cool', fan: 'fan', drying: '', idle: '', off: '', preheating: 'heat'},
            }),
        );
        if (Object.keys(climate).length === 0) {
            delete draft.options.climate;
        }
        if (str(c.current_humidity_topic) !== undefined) {
            const humidity = this.draft(`${entity.id}_humidity`, entity);
            this.addType(humidity, 'HumiditySensor');
            this.bind(
                humidity,
                {attribute: 'RelativeHumidityMeasurement.measuredValue'},
                this.status(entity, 'current_humidity_topic', 'current_humidity_template', {
                    unit: 'percent100ths',
                    type: 'number',
                }),
            );
        }
        for (const [field, what] of [
            ['fan_mode_command_topic', 'fan modes'],
            ['swing_mode_command_topic', 'swing modes'],
            ['preset_mode_command_topic', 'preset modes'],
            ['target_humidity_command_topic', 'the target humidity'],
        ] as const) {
            if (str(c[field]) !== undefined) {
                this.skip(entity, `${what} are not mapped`);
            }
        }
    }

    lock(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'DoorLock');
        const lock = text(c.payload_lock, 'LOCK');
        const unlock = text(c.payload_unlock, 'UNLOCK');
        const map: Record<string, string> = {
            [text(c.state_locked, 'LOCKED')]: 'Locked',
            [text(c.state_unlocked, 'UNLOCKED')]: 'Unlocked',
            [text(c.state_jammed, 'JAMMED')]: 'NotFullyLocked',
        };
        this.bind(
            draft,
            {attribute: 'DoorLock.lockState'},
            this.status(entity, 'state_topic', 'value_template', {map}),
            this.command(
                entity,
                'command_topic',
                'command_template',
                {format: {Locked: lock, Unlocked: unlock}},
                `{% set value = ${JSON.stringify(lock)} if name == "Locked" else ${JSON.stringify(unlock)} %}`,
                ['code'],
            ),
        );
    }

    fan(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'Fan');
        draft.coalesce = 50;
        const on = text(c.payload_on, 'ON');
        const off = text(c.payload_off, 'OFF');
        this.onOffMapping(entity, draft, 'state_topic', 'state_value_template', on, off);
        if (str(c.percentage_command_topic) !== undefined || str(c.percentage_state_topic) !== undefined) {
            const max = num(c.speed_range_max) ?? 100;
            const scale = {from: [0, max] as [number, number], to: [0, 100] as [number, number]};
            this.bind(
                draft,
                {attribute: 'FanControl.percentSetting'},
                this.status(entity, 'percentage_state_topic', 'percentage_value_template', {scale, type: 'number'}),
                this.command(entity, 'percentage_command_topic', 'percentage_command_template', {scale, round: 0}),
            );
        }
        const presets = list(c.preset_modes);
        if (presets.length > 0) {
            const names: Record<string, string> = {
                off: 'Off',
                low: 'Low',
                medium: 'Medium',
                high: 'High',
                auto: 'Auto',
                on: 'On',
                smart: 'Smart',
            };
            const map: Record<string, string> = {};
            const format: Record<string, string> = {};
            const sets: string[] = [];
            for (const preset of presets) {
                const name = names[preset.toLowerCase()];
                if (name !== undefined) {
                    map[preset] = name;
                    format[name] = preset;
                    sets.push(`${JSON.stringify(preset)} if name == ${JSON.stringify(name)}`);
                }
            }
            if (Object.keys(map).length > 0) {
                this.bind(
                    draft,
                    {attribute: 'FanControl.fanMode'},
                    this.status(entity, 'preset_mode_state_topic', 'preset_mode_value_template', {map}),
                    this.command(
                        entity,
                        'preset_mode_command_topic',
                        'preset_mode_command_template',
                        {format},
                        `{% set value = ${sets.join(' else ')} else name | lower %}`,
                    ),
                );
            }
            const other = presets.filter((p) => names[p.toLowerCase()] === undefined);
            if (other.length > 0) {
                this.skip(entity, `preset modes ${other.join(', ')} have no fan mode`);
            }
        }
        if (str(c.oscillation_command_topic) !== undefined) {
            this.skip(entity, 'oscillation is not mapped');
        }
        if (str(c.direction_command_topic) !== undefined) {
            this.skip(entity, 'direction is not mapped');
        }
    }

    valve(entity: RawEntity): void {
        const c = entity.config;
        const draft = this.draft(entity.id, entity, true);
        this.addType(draft, 'WaterValve');
        const map: Record<string, string> = {
            [text(c.state_open, 'open')]: 'Open',
            [text(c.state_opening, 'opening')]: 'Transitioning',
            [text(c.state_closed, 'closed')]: 'Closed',
            [text(c.state_closing, 'closing')]: 'Transitioning',
        };
        this.bind(
            draft,
            {attribute: 'ValveConfigurationAndControl.currentState'},
            this.status(entity, 'state_topic', 'value_template', {map}),
        );
        const command = str(c.command_topic);
        if (command !== undefined) {
            this.bind(draft, {invoke: 'ValveConfigurationAndControl.open'}, undefined, {
                topic: command,
                payload: text(c.payload_open, 'OPEN'),
            });
            this.bind(draft, {invoke: 'ValveConfigurationAndControl.close'}, undefined, {
                topic: command,
                payload: text(c.payload_close, 'CLOSE'),
            });
        }
    }

    binarySensor(entity: RawEntity): void {
        const c = entity.config;
        const on = text(c.payload_on, 'ON');
        const off = text(c.payload_off, 'OFF');
        const deviceClass = str(c.device_class);
        const status = (map: Record<string, string | boolean>): StatusInput | undefined =>
            this.status(entity, 'state_topic', 'value_template', {map});
        const sensor = (type: string, attribute: string, map: Record<string, string | boolean>): void => {
            const draft = this.draft(entity.id, entity);
            this.addType(draft, type);
            this.bind(draft, {attribute}, status(map));
        };
        switch (deviceClass) {
            case 'door':
            case 'window':
            case 'opening':
            case 'garage_door':
                // Home Assistant's "on" is the open contact; Matter's true is the closed one
                sensor('ContactSensor', 'BooleanState.stateValue', {[on]: false, [off]: true});
                return;
            case 'motion':
            case 'occupancy':
            case 'presence':
            case 'moving':
                sensor('OccupancySensor', 'OccupancySensing.occupancy', {[on]: true, [off]: false});
                return;
            case 'moisture':
                sensor('WaterLeakDetector', 'BooleanState.stateValue', {[on]: true, [off]: false});
                return;
            case 'cold':
                sensor('WaterFreezeDetector', 'BooleanState.stateValue', {[on]: true, [off]: false});
                return;
            case 'smoke': {
                const draft = this.draft(entity.id, entity);
                this.addType(draft, 'SmokeCoAlarm');
                this.addFeature(draft, 'SmokeCoAlarm', 'SmokeAlarm');
                this.bind(draft, {attribute: 'SmokeCoAlarm.smokeState'}, status({[on]: 'Critical', [off]: 'Normal'}));
                return;
            }
            case 'carbon_monoxide': {
                const draft = this.draft(entity.id, entity);
                this.addType(draft, 'SmokeCoAlarm');
                this.addFeature(draft, 'SmokeCoAlarm', 'CoAlarm');
                this.bind(draft, {attribute: 'SmokeCoAlarm.coState'}, status({[on]: 'Critical', [off]: 'Normal'}));
                return;
            }
            case 'battery':
                this.bind(
                    this.powerDraft(),
                    {attribute: 'PowerSource.batChargeLevel'},
                    status({[on]: 'Critical', [off]: 'Ok'}),
                );
                return;
            case 'battery_charging': {
                const power = this.powerDraft();
                this.addFeature(power, 'PowerSource', 'Rechargeable');
                // mandatory with the feature; `Unknown` until the first report
                power.attributes.PowerSource = {...power.attributes.PowerSource, batChargeState: 0};
                this.bind(
                    power,
                    {attribute: 'PowerSource.batChargeState'},
                    status({[on]: 'IsCharging', [off]: 'IsNotCharging'}),
                );
                return;
            }
            default:
                this.skip(
                    entity,
                    deviceClass === undefined
                        ? 'no device_class; a binary sensor without one has no Matter sensor type'
                        : `device_class ${deviceClass} has no Matter sensor type`,
                );
        }
    }

    sensor(entity: RawEntity): void {
        const c = entity.config;
        const unit = str(c.unit_of_measurement);
        // the unit alone settles a few classes; nothing is guessed from names
        const deviceClass =
            str(c.device_class) ??
            (unit === '°C' || unit === '°F' ? 'temperature' : unit === 'lx' ? 'illuminance' : undefined);
        const draft = (): Draft => this.draft(entity.id, entity);
        const bindStatus = (d: Draft, type: string, attribute: string, extra: Partial<StatusInput>): void => {
            this.addType(d, type);
            this.bind(d, {attribute}, this.status(entity, 'state_topic', 'value_template', {type: 'number', ...extra}));
        };
        const factor = (f: number): Partial<StatusInput> => ({scale: {from: [0, 1], to: [0, f], clamp: false}});
        switch (deviceClass) {
            case 'temperature':
                if (unit === '°C' || unit === 'C' || unit === undefined) {
                    bindStatus(draft(), 'TemperatureSensor', 'TemperatureMeasurement.measuredValue', {unit: 'celsius'});
                    return;
                }
                if (unit === '°F' || unit === 'F') {
                    bindStatus(draft(), 'TemperatureSensor', 'TemperatureMeasurement.measuredValue', {
                        unit: 'fahrenheit',
                    });
                    return;
                }
                break;
            case 'humidity':
                if (unit === '%' || unit === undefined) {
                    bindStatus(draft(), 'HumiditySensor', 'RelativeHumidityMeasurement.measuredValue', {
                        unit: 'percent100ths',
                    });
                    return;
                }
                break;
            case 'pressure':
            case 'atmospheric_pressure': {
                const factors: Record<string, number> = {
                    hPa: 1,
                    mbar: 1,
                    kPa: 10,
                    Pa: 0.01,
                    bar: 1000,
                    psi: 68.9476,
                    inHg: 33.8639,
                    mmHg: 1.33322,
                };
                const f = unit === undefined ? undefined : factors[unit];
                if (f !== undefined) {
                    bindStatus(draft(), 'PressureSensor', 'PressureMeasurement.measuredValue', {
                        ...(f === 1 ? {} : factor(f)),
                        round: 0,
                    });
                    return;
                }
                break;
            }
            case 'illuminance':
                if (unit === 'lx' || unit === undefined) {
                    bindStatus(draft(), 'LightSensor', 'IlluminanceMeasurement.measuredValue', {unit: 'lux'});
                    return;
                }
                break;
            case 'battery':
                if (unit === '%' || unit === undefined) {
                    this.bind(
                        this.powerDraft(),
                        {attribute: 'PowerSource.batPercentRemaining'},
                        this.status(entity, 'state_topic', 'value_template', {type: 'number', unit: 'halfPercent'}),
                    );
                    return;
                }
                break;
            case 'carbon_dioxide':
                if (unit === 'ppm') {
                    bindStatus(draft(), 'AirQualitySensor', 'CarbonDioxideConcentrationMeasurement.measuredValue', {});
                    return;
                }
                break;
            case 'carbon_monoxide':
                if (unit === 'ppm') {
                    bindStatus(draft(), 'AirQualitySensor', 'CarbonMonoxideConcentrationMeasurement.measuredValue', {});
                    return;
                }
                break;
            case 'pm1':
            case 'pm25':
            case 'pm10': {
                if (unit === 'µg/m³' || unit === 'μg/m³') {
                    const cluster =
                        deviceClass === 'pm25'
                            ? 'Pm25ConcentrationMeasurement'
                            : deviceClass === 'pm10'
                              ? 'Pm10ConcentrationMeasurement'
                              : 'Pm1ConcentrationMeasurement';
                    bindStatus(draft(), 'AirQualitySensor', `${cluster}.measuredValue`, {});
                    return;
                }
                break;
            }
            case 'volatile_organic_compounds_parts':
            case 'volatile_organic_compounds':
            case 'nitrogen_dioxide':
            case 'ozone':
            case 'formaldehyde': {
                const clusters: Record<string, string> = {
                    volatile_organic_compounds_parts: 'TotalVolatileOrganicCompoundsConcentrationMeasurement',
                    volatile_organic_compounds: 'TotalVolatileOrganicCompoundsConcentrationMeasurement',
                    nitrogen_dioxide: 'NitrogenDioxideConcentrationMeasurement',
                    ozone: 'OzoneConcentrationMeasurement',
                    formaldehyde: 'FormaldehydeConcentrationMeasurement',
                };
                const cluster = clusters[deviceClass] ?? '';
                if (unit === 'ppb') {
                    bindStatus(draft(), 'AirQualitySensor', `${cluster}.measuredValue`, {});
                    return;
                }
                if (unit === 'ppm') {
                    bindStatus(draft(), 'AirQualitySensor', `${cluster}.measuredValue`, factor(1000));
                    return;
                }
                break;
            }
            case 'aqi': {
                // the US AQI bands onto Matter's six levels
                const d = draft();
                this.addType(d, 'AirQualitySensor');
                const base = this.status(entity, 'state_topic', 'value_template');
                if (base !== undefined) {
                    const inner =
                        base.template === undefined ? 'value' : `(${base.template.replace(/^\{\{|\}\}$/g, '').trim()})`;
                    base.template = `{% set aqi = ${inner} | float(-1) %}{{ 'Unknown' if aqi < 0 else 'Good' if aqi <= 50 else 'Fair' if aqi <= 100 else 'Moderate' if aqi <= 150 else 'Poor' if aqi <= 200 else 'VeryPoor' if aqi <= 300 else 'ExtremelyPoor' }}`;
                    this.bind(d, {attribute: 'AirQuality.airQuality'}, base);
                }
                return;
            }
            case 'volume_flow_rate':
                if (unit === 'm³/h') {
                    bindStatus(draft(), 'FlowSensor', 'FlowMeasurement.measuredValue', {...factor(10), round: 0});
                    return;
                }
                break;
            case 'voltage':
            case 'current':
            case 'power':
            case 'energy':
            case 'apparent_power':
            case 'reactive_power':
            case 'power_factor':
            case 'frequency':
                this.skip(entity, `device_class ${deviceClass}: electrical measurement is not mapped yet`);
                return;
            default:
                break;
        }
        if (deviceClass === undefined) {
            this.skip(entity, `no device_class${unit === undefined ? '' : ` (${unit})`}; no Matter sensor type`);
        } else {
            this.skip(
                entity,
                `device_class ${deviceClass}${unit === undefined ? '' : ` in ${unit}`} has no Matter sensor type`,
            );
        }
    }

    event(entity: RawEntity): void {
        const c = entity.config;
        const types = list(c.event_types);
        const {buttons, ignored} = parseActions(types);
        for (const value of ignored) {
            this.unmapped.push(`${entity.component} "${entityName(entity)}": event type ${value} is no press`);
        }
        const topic = str(c.state_topic);
        if (topic === undefined) {
            return;
        }
        for (const button of buttons) {
            const draft = this.draft(button.name === '' ? entity.id : `${entity.id}_${button.name}`, entity);
            this.addType(draft, 'GenericSwitch');
            draft.options.switch = {multiPressMax: Math.max(2, multiPressMax(button))};
            const status = this.status(entity, 'state_topic', 'value_template', {
                extract: 'event_type',
                map: Object.fromEntries(button.kinds),
            });
            if (status?.template !== undefined) {
                // a value_template renders the event type itself
                delete status.extract;
            }
            this.bind(draft, {event: 'Switch'}, status);
        }
    }

    deviceTrigger(entity: RawEntity): void {
        const c = entity.config;
        const topic = str(c.topic);
        const type = str(c.type);
        const subtype = str(c.subtype);
        const payload = c.payload;
        if (topic === undefined || type === undefined || subtype === undefined || payload === undefined) {
            this.skip(entity, 'a device trigger needs topic, type, subtype and payload');
            return;
        }
        if (str(c.automation_type) !== 'trigger') {
            this.skip(entity, `automation_type ${str(c.automation_type) ?? '?'} is not a trigger`);
            return;
        }
        let name: string;
        let kind: string | undefined;
        if (type === 'action') {
            const parsed = parseAction(subtype);
            if (parsed === undefined) {
                this.unmapped.push(`${entity.component}: action ${subtype} is no press`);
                return;
            }
            name = parsed.button;
            kind = parsed.kind;
        } else {
            name = subtype;
            kind = parseAction(type.replace(/^button_/, ''))?.kind;
            if (kind === undefined) {
                this.unmapped.push(`${entity.component}: trigger type ${type} is no press`);
                return;
            }
        }
        const template = this.template(entity, 'value_template', 'status');
        if (template?.startsWith('\u0000') === true) {
            return;
        }
        const key = `${topic}\u0000${name}`;
        let trigger = this.triggers.get(key);
        if (trigger === undefined) {
            trigger = {topic, template, button: {name, kinds: new Map()}};
            this.triggers.set(key, trigger);
        }
        trigger.button.kinds.set(text(payload, JSON.stringify(payload)), kind);
    }

    private finishTriggers(): void {
        for (const {topic, template, button} of this.triggers.values()) {
            const draft = this.draft(button.name === '' ? 'button' : `button_${button.name}`, undefined);
            this.addType(draft, 'GenericSwitch');
            draft.options.switch = {multiPressMax: Math.max(2, multiPressMax(button))};
            const status: StatusInput = {topic, map: Object.fromEntries(button.kinds)};
            if (template !== undefined) {
                status.template = template;
            }
            this.bind(draft, {event: 'Switch'}, status);
        }
    }

    walk(entities: RawEntity[]): void {
        const sorted = [...entities].sort(
            (a, b) => componentRank(a.component) - componentRank(b.component) || a.id.localeCompare(b.id),
        );
        for (const entity of sorted) {
            const c = entity.config;
            const category = str(c.entity_category);
            const battery =
                (entity.component === 'sensor' || entity.component === 'binary_sensor') &&
                (str(c.device_class) === 'battery' || str(c.device_class) === 'battery_charging');
            // settings and metrics are not the device's function — except the battery, which Matter has a place for
            if (category !== undefined && !battery) {
                this.skip(entity, `${category} entity (a setting or a metric, not the device's function)`);
                continue;
            }
            if (c.enabled_by_default === false) {
                this.skip(entity, 'disabled by default');
                continue;
            }
            this.takeAvailability(entity);
            switch (entity.component) {
                case 'switch':
                    this.switch(entity);
                    break;
                case 'light':
                    this.light(entity);
                    break;
                case 'cover':
                    this.cover(entity);
                    break;
                case 'climate':
                    this.climate(entity);
                    break;
                case 'lock':
                    this.lock(entity);
                    break;
                case 'fan':
                    this.fan(entity);
                    break;
                case 'valve':
                    this.valve(entity);
                    break;
                case 'binary_sensor':
                    this.binarySensor(entity);
                    break;
                case 'sensor':
                    this.sensor(entity);
                    break;
                case 'event':
                    this.event(entity);
                    break;
                case 'device_trigger':
                case 'device_automation':
                    this.deviceTrigger(entity);
                    break;
                case 'button':
                    this.skip(entity, 'a Matter button emits events, it cannot be pressed; no equivalent');
                    break;
                case 'number':
                case 'select':
                case 'text':
                    this.skip(entity, 'not representable in Matter (unmapped by default)');
                    break;
                case 'scene':
                    this.skip(entity, 'scenes are not mapped yet');
                    break;
                default:
                    this.skip(entity, `the ${entity.component} component has no Matter equivalent`);
            }
        }
        this.finishTriggers();
    }

    get deviceAvailability(): AvailabilityInput | undefined {
        return this.availability;
    }

    /** the endpoints in their final form: the device's own first, children after; undefined when nothing maps */
    endpoints(area: string | undefined): EndpointInput[] | undefined {
        const real = [...this.drafts.values()].filter((d) => d.types.length > 0 && d.mappings.length > 0);
        const isButton = (d: Draft): boolean => d.types[0] === 'GenericSwitch';
        let main = real.find((d) => d.primary) ?? real.find((d) => !isButton(d)) ?? real[0];
        if (main === undefined) {
            if (this.power !== undefined && this.power.mappings.length > 0) {
                main = this.power;
            } else {
                return undefined;
            }
        } else if (this.power !== undefined && this.power.mappings.length > 0) {
            this.addType(main, 'PowerSource');
            main.mappings.push(...this.power.mappings);
            for (const [cluster, features] of Object.entries(this.power.features)) {
                for (const feature of features) {
                    this.addFeature(main, cluster, feature);
                }
            }
            for (const [cluster, attributes] of Object.entries(this.power.attributes)) {
                main.attributes[cluster] = {...main.attributes[cluster], ...attributes};
            }
        }
        const ordered = [main, ...real.filter((d) => d !== main)];
        const typeCount = new Map<string, number>();
        for (const draft of ordered) {
            const type = draft.types[0] ?? '';
            typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
        }
        let tag = 0;
        return ordered.map((draft, i) => {
            const endpoint: EndpointInput = {deviceTypes: draft.types, mappings: draft.mappings};
            const tags: Record<string, unknown>[] = [];
            if (i > 0) {
                endpoint.id = draft.id;
                // children sharing their device type with a sibling carry a number tag: Matter's disambiguation rule
                if ((typeCount.get(draft.types[0] ?? '') ?? 0) > 1) {
                    tag++;
                    tags.push({mfgCode: null, namespaceId: NUMBER_NAMESPACE, tag, label: draft.id.slice(0, 64)});
                }
            } else if (area !== undefined) {
                const found = areaTag(area);
                if (found !== undefined) {
                    tags.push({mfgCode: null, namespaceId: AREA_NAMESPACE, tag: found.id, label: area.slice(0, 64)});
                }
            }
            if (tags.length > 0) {
                draft.features.Descriptor = ['TagList'];
                draft.attributes.Descriptor = {tagList: tags};
            }
            if (Object.keys(draft.features).length > 0) {
                endpoint.features = draft.features;
            }
            if (Object.keys(draft.attributes).length > 0) {
                endpoint.attributes = draft.attributes;
            }
            if (Object.keys(draft.options).length > 0) {
                endpoint.options = draft.options;
            }
            if (draft.coalesce > 0) {
                endpoint.coalesce = draft.coalesce;
            }
            return endpoint;
        });
    }
}

/** the baseline for a device description, or — when nothing of it maps onto Matter — only the reasons */
export function generateReport(raw: RawDevice): {device?: DeviceInput; unmapped: string[]} {
    const builder = new Builder();
    builder.walk(raw.entities);
    const area = label(str(raw.device.suggested_area));
    const endpoints = builder.endpoints(area);
    if (endpoints === undefined) {
        return {unmapped: builder.unmapped};
    }
    const first = raw.entities[0];
    const name =
        label(str(raw.device.name)) ?? (first === undefined ? raw.identity : label(entityName(first))) ?? raw.identity;
    const vendor = label(str(raw.device.manufacturer));
    const model = label(str(raw.device.model));
    const serial = label(str(raw.device.serial_number)) ?? raw.identity.slice(0, MAX_LABEL);
    const availability = builder.deviceAvailability;
    const device: DeviceInput = {
        name: name.slice(0, MAX_LABEL),
        ...(vendor === undefined ? {} : {vendor}),
        ...(model === undefined ? {} : {model}),
        serial,
        source: {kind: 'ha-discovery', key: raw.identity, version: rawHash(raw), raw},
        ...(availability === undefined ? {} : {availability}),
        endpoints,
    };
    return {device, unmapped: builder.unmapped};
}

/** the baseline for a device description; undefined when nothing of it maps onto Matter */
export function generateDevice(raw: RawDevice): Generated | undefined {
    const report = generateReport(raw);
    return report.device === undefined ? undefined : {device: report.device, unmapped: report.unmapped};
}

/** regenerate the baseline from what `source.raw` holds */
export function generate(raw: RawDevice): Generated | undefined {
    return generateDevice(raw);
}

export {deviceIdentity};
