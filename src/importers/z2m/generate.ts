/* zigbee2mqtt → the manual model. One `bridge/devices` entry becomes one device: its exposes decide the
   device types, clusters and bindings per zigbee2mqtt endpoint (`l1`, `l2`, … become child endpoints),
   `action` enums become GenericSwitch children, `battery` a power source, and every device gets its
   availability topic. A `bridge/groups` entry becomes one endpoint with the union of its members' light,
   switch or cover features. What is generated is the *baseline*; `source.raw` keeps what is needed to
   regenerate it, so a user's edits can be carried over when zigbee2mqtt's description changes.

   The topics are zigbee2mqtt's: `<base>/<friendly_name>` (state, JSON), `…/set`, `…/get`,
   `…/availability`. Multi-endpoint devices are addressed through the property suffix (`state_l1`) on the
   device's own `/set` topic. */

import {createHash} from 'node:crypto';

import type {z} from 'zod';

import type {
    BindingInput,
    CoverOptionsSchema,
    DeviceInput,
    EndpointInput,
    OptionsInput,
    StatusHalfSchema,
} from '../../model/index.ts';

import {multiPressMax, parseActions} from '../actions.ts';
import type {Generated} from '../sync.ts';
import {type BridgeDevice, type BridgeGroup, type Expose, canGet, canRead, canSet} from './types.ts';

export const SOURCE_KIND = 'z2m';
export const DEFAULT_BASE_TOPIC = 'zigbee2mqtt';
/** bumped when the generator's output for the same raw description changes */
export const GENERATOR_VERSION = 1;

export const deviceKey = (ieee: string): string => `${SOURCE_KIND}:${ieee}`;
export const groupKey = (id: number): string => `${SOURCE_KIND}:group:${id}`;

/** availability payloads: `{"state":"online"}` (zigbee2mqtt ≥ 1.22) or plain `online` (legacy) */
export const AVAILABILITY_TEMPLATE =
    '{{ value_json.state if value_json is defined and value_json.state is defined else value }}';

/** what `source.raw` holds for a device: the description trimmed to what regenerates the baseline */
export interface RawDevice {
    kind: 'device';
    base_topic: string;
    ieee_address: string;
    friendly_name: string;
    type: string;
    power_source?: string;
    model_id?: string;
    manufacturer?: string;
    definition: {vendor?: string; model?: string; description?: string; exposes: Expose[]} | null;
}

/** the union of a group's members, computed from their descriptions when the group is (re)generated */
export interface GroupUnion {
    kind: 'light' | 'switch' | 'cover' | undefined;
    brightness: boolean;
    colorTemp: {min: number | undefined; max: number | undefined} | undefined;
    xy: boolean;
    hs: boolean;
    position: boolean;
    tilt: boolean;
    members: number;
}

export interface RawGroup {
    kind: 'group';
    base_topic: string;
    id: number;
    friendly_name: string;
    members: {ieee_address: string; endpoint: number}[];
    union: GroupUnion;
}

export type Raw = RawDevice | RawGroup;

/** the device plus the exposes (property names) and action values that have no Matter equivalent */
export type {Generated};

const MAX_LABEL = 32;
const label = (text: string | undefined): string | undefined =>
    text === undefined || text === '' ? undefined : text.slice(0, MAX_LABEL);

/** an endpoint id the schema accepts */
export function endpointId(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9:._-]/g, '_');
    return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `e${cleaned}`;
}

export function rawHash(raw: Raw): string {
    return `${GENERATOR_VERSION}.${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 12)}`;
}

/** the description trimmed: descriptions and labels of the exposes carry nothing the generator needs */
function trimExpose(expose: Expose): Expose {
    const trimmed: Expose = {...expose};
    delete trimmed.description;
    delete trimmed.label;
    if (trimmed.features !== undefined) {
        trimmed.features = trimmed.features.map(trimExpose);
    }
    return trimmed;
}

/** a payload value as the text a map key or format value is written with */
function text(value: unknown, fallback: string): string {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : fallback;
}

export function rawDevice(device: BridgeDevice, baseTopic: string): RawDevice {
    const definition = device.definition ?? null;
    return {
        kind: 'device',
        base_topic: baseTopic,
        ieee_address: device.ieee_address,
        friendly_name: device.friendly_name,
        type: device.type,
        ...(device.power_source === undefined ? {} : {power_source: device.power_source}),
        ...(device.model_id === undefined ? {} : {model_id: device.model_id}),
        ...(device.manufacturer === undefined ? {} : {manufacturer: device.manufacturer}),
        definition:
            definition === null
                ? null
                : {
                      ...(definition.vendor === undefined ? {} : {vendor: definition.vendor}),
                      ...(definition.model === undefined ? {} : {model: definition.model}),
                      ...(definition.description === undefined ? {} : {description: definition.description}),
                      exposes: (definition.exposes ?? []).map(trimExpose),
                  },
    };
}

/* ----- the drafts an expose walk fills ----- */

type CoverOptionsInput = z.input<typeof CoverOptionsSchema>;
type StatusInput = z.input<typeof StatusHalfSchema>;

interface Draft {
    /** the zigbee2mqtt endpoint name; `''` is the device itself */
    z2mEndpoint: string;
    id: string;
    types: string[];
    bindings: BindingInput[];
    features: Record<string, string[]>;
    options: OptionsInput;
    coalesce: number;
    /** one `/get` per endpoint: on the first gettable feature */
    hasGet: boolean;
}

/** the order device types take on an endpoint: the first is the endpoint's own type */
const TYPE_ORDER = [
    'ExtendedColorLight',
    'ColorTemperatureLight',
    'DimmableLight',
    'OnOffLight',
    'WindowCovering',
    'Thermostat',
    'DoorLock',
    'Fan',
    'OnOffPlugInUnit',
    'OccupancySensor',
    'ContactSensor',
    'WaterLeakDetector',
    'RainSensor',
    'SmokeCoAlarm',
    'AirQualitySensor',
    'TemperatureSensor',
    'HumiditySensor',
    'PressureSensor',
    'LightSensor',
    'GenericSwitch',
    'PowerSource',
];
const typeRank = (name: string): number => {
    const i = TYPE_ORDER.indexOf(name);
    return i === -1 ? TYPE_ORDER.length : i;
};

/** the Common Number semantic tag namespace (Matter namespaces, 0x07): `One`, `Two`, … for sibling endpoints */
const NUMBER_NAMESPACE = 7;

/** covers that echo the target position once before the real movement reports (the family's echo filter) */
const COVER_QUIRKS: Record<string, CoverOptionsInput> = {
    E1757: {echoFilter: true},
    E1926: {echoFilter: true},
};

class Builder {
    readonly drafts = new Map<string, Draft>();
    readonly unmapped: string[] = [];
    readonly stateTopic: string;
    readonly setTopic: string;
    readonly getTopic: string;

    readonly hasBattery: boolean;

    constructor(baseTopic: string, friendlyName: string, hasBattery: boolean) {
        this.hasBattery = hasBattery;
        this.stateTopic = `${baseTopic}/${friendlyName}`;
        this.setTopic = `${this.stateTopic}/set`;
        this.getTopic = `${this.stateTopic}/get`;
    }

    draft(z2mEndpoint: string, id = z2mEndpoint): Draft {
        let draft = this.drafts.get(id);
        if (draft === undefined) {
            draft = {z2mEndpoint, id, types: [], bindings: [], features: {}, options: {}, coalesce: 0, hasGet: false};
            this.drafts.set(id, draft);
        }
        return draft;
    }

    addType(draft: Draft, type: string): void {
        if (!draft.types.includes(type)) {
            draft.types.push(type);
            draft.types.sort((a, b) => typeRank(a) - typeRank(b));
        }
    }

    addFeature(draft: Draft, cluster: string, feature: string): void {
        const list = (draft.features[cluster] ??= []);
        if (!list.includes(feature)) {
            list.push(feature);
        }
    }

    property(expose: Expose): string {
        return (
            expose.property ??
            (expose.endpoint === undefined ? (expose.name ?? '') : `${expose.name}_${expose.endpoint}`)
        );
    }

    /** a status half on the device's state topic */
    status(expose: Expose, extra: Partial<StatusInput> = {}): StatusInput {
        return {topic: this.stateTopic, extract: this.property(expose), ...extra};
    }

    /** a command half on the device's `/set` topic, the property as the JSON key */
    command(expose: Expose, extra: Record<string, unknown> = {}): Record<string, unknown> {
        return {topic: this.setTopic, wrap: this.property(expose), ...extra};
    }

    /** a binding from a feature's access bits; `get` on the endpoint's first gettable feature */
    bind(
        draft: Draft,
        attribute: string,
        expose: Expose,
        statusExtra: Partial<StatusInput> = {},
        commandExtra: Record<string, unknown> = {},
    ): BindingInput | undefined {
        const binding: Record<string, unknown> = {attribute};
        if (canRead(expose)) {
            const status = this.status(expose, statusExtra);
            if (canGet(expose) && !draft.hasGet) {
                draft.hasGet = true;
                status.get = {topic: this.getTopic, payload: JSON.stringify({[this.property(expose)]: ''})};
            }
            binding.status = status;
        }
        if (canSet(expose)) {
            binding.command = this.command(expose, commandExtra);
        }
        if (binding.status === undefined && binding.command === undefined) {
            return undefined;
        }
        draft.bindings.push(binding as BindingInput);
        return binding as BindingInput;
    }

    skip(expose: Expose): void {
        const name = this.property(expose);
        if (name !== '' && !this.unmapped.includes(name)) {
            this.unmapped.push(name);
        }
    }

    /* ----- specific exposes ----- */

    light(expose: Expose): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const endpoint = expose.endpoint ?? features[0]?.endpoint ?? '';
        const draft = this.draft(endpoint);
        const state = by.get('state');
        const brightness = by.get('brightness');
        const colorTemp = by.get('color_temp');
        const xy = by.get('color_xy');
        const hs = by.get('color_hs');
        this.addType(
            draft,
            xy !== undefined || hs !== undefined
                ? 'ExtendedColorLight'
                : colorTemp !== undefined
                  ? 'ColorTemperatureLight'
                  : brightness !== undefined
                    ? 'DimmableLight'
                    : 'OnOffLight',
        );
        draft.coalesce = 50;
        if (state !== undefined) {
            this.onOff(draft, state);
        }
        if (brightness !== undefined) {
            // zigbee2mqtt's brightness is Matter's level (1–254); a 0 is clamped to 1
            const scale = {from: [1, 254] as [number, number], to: [1, 254] as [number, number]};
            this.bind(draft, 'LevelControl.currentLevel', brightness, {scale}, {scale, round: 0});
        }
        if (colorTemp !== undefined) {
            this.bind(draft, 'ColorControl.colorTemperatureMireds', colorTemp);
            const light = (draft.options.light ??= {});
            if (colorTemp.value_min !== undefined) {
                light.minMireds = Math.max(1, Math.round(colorTemp.value_min));
            }
            if (colorTemp.value_max !== undefined) {
                light.maxMireds = Math.min(65279, Math.round(colorTemp.value_max));
            }
        }
        if (xy !== undefined) {
            this.bind(draft, 'ColorControl.colorXy', xy);
            if (hs !== undefined) {
                this.addFeature(draft, 'ColorControl', 'HueSaturation');
            }
        } else if (hs !== undefined) {
            this.bind(draft, 'ColorControl.colorHs', hs);
        }
        if ((xy !== undefined || hs !== undefined) && colorTemp !== undefined) {
            // zigbee2mqtt reports which representation is current; without it the last report would win
            const property = endpoint === '' ? 'color_mode' : `color_mode_${endpoint}`;
            draft.bindings.push({
                attribute: 'ColorControl.colorMode',
                status: {
                    topic: this.stateTopic,
                    extract: property,
                    map: {
                        xy: 'CurrentXAndCurrentY',
                        hs: 'CurrentHueAndCurrentSaturation',
                        color_temp: 'ColorTemperatureMireds',
                    },
                },
            });
        }
        for (const feature of features) {
            if (!['state', 'brightness', 'color_temp', 'color_xy', 'color_hs'].includes(feature.name ?? '')) {
                this.skip(feature);
            }
        }
    }

    onOff(draft: Draft, state: Expose): void {
        const on = text(state.value_on, 'ON');
        const off = text(state.value_off, 'OFF');
        this.bind(draft, 'OnOff.onOff', state, {map: {[on]: true, [off]: false}}, {format: {true: on, false: off}});
    }

    switch(expose: Expose): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const draft = this.draft(expose.endpoint ?? features[0]?.endpoint ?? '');
        this.addType(draft, 'OnOffPlugInUnit');
        const state = by.get('state');
        if (state !== undefined) {
            this.onOff(draft, state);
        }
        for (const feature of features) {
            if (feature.name !== 'state') {
                this.skip(feature);
            }
        }
    }

    cover(expose: Expose, model: string | undefined): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const draft = this.draft(expose.endpoint ?? features[0]?.endpoint ?? '');
        this.addType(draft, 'WindowCovering');
        const position = by.get('position');
        const tilt = by.get('tilt');
        const state = by.get('state');
        // zigbee2mqtt: 100 = open; Matter: 0 = open
        const scale = {from: [0, 100] as [number, number], to: [10000, 0] as [number, number]};
        if (position !== undefined) {
            if (canRead(position)) {
                const status = this.status(position, {scale});
                if (canGet(position) && !draft.hasGet) {
                    draft.hasGet = true;
                    status.get = {topic: this.getTopic, payload: JSON.stringify({[this.property(position)]: ''})};
                }
                draft.bindings.push({attribute: 'WindowCovering.currentPositionLiftPercent100ths', status});
            }
            if (canSet(position)) {
                draft.bindings.push({
                    attribute: 'WindowCovering.targetPositionLiftPercent100ths',
                    command: this.command(position, {scale, round: 0}) as BindingInput['command'],
                });
            }
        }
        if (tilt !== undefined) {
            if (canRead(tilt)) {
                draft.bindings.push({
                    attribute: 'WindowCovering.currentPositionTiltPercent100ths',
                    status: this.status(tilt, {scale}),
                });
            }
            if (canSet(tilt)) {
                draft.bindings.push({
                    attribute: 'WindowCovering.targetPositionTiltPercent100ths',
                    command: this.command(tilt, {scale, round: 0}) as BindingInput['command'],
                });
            }
        }
        if (state !== undefined && canSet(state)) {
            const values = (state.values ?? ['OPEN', 'CLOSE', 'STOP']).map(String);
            const find = (word: string): string | undefined =>
                values.find((v) => v.toUpperCase() === word) ?? values.find((v) => v.toUpperCase().startsWith(word));
            const open = find('OPEN');
            const close = find('CLOSE');
            const stop = find('STOP');
            if (position === undefined) {
                if (open !== undefined) {
                    draft.bindings.push({
                        invoke: 'WindowCovering.upOrOpen',
                        command: this.command(state, {payload: open}) as BindingInput['command'],
                    });
                }
                if (close !== undefined) {
                    draft.bindings.push({
                        invoke: 'WindowCovering.downOrClose',
                        command: this.command(state, {payload: close}) as BindingInput['command'],
                    });
                }
            }
            if (stop !== undefined) {
                draft.bindings.push({
                    invoke: 'WindowCovering.stopMotion',
                    command: this.command(state, {payload: stop}) as BindingInput['command'],
                });
            }
        }
        const quirks = model === undefined ? undefined : COVER_QUIRKS[model];
        if (quirks !== undefined) {
            draft.options.cover = {...(draft.options.cover ?? {}), ...quirks};
        }
        for (const feature of features) {
            if (!['position', 'tilt', 'state'].includes(feature.name ?? '')) {
                this.skip(feature);
            }
        }
        this.covers.push({draft, state, positionAware: position !== undefined});
    }

    /** the covers of the walk; their movement binding is decided when every expose was seen */
    private readonly covers: {draft: Draft; state: Expose | undefined; positionAware: boolean}[] = [];

    /** `moving` / `motor_state` enums seen on the walk, per zigbee2mqtt endpoint; the cover takes them */
    private readonly motionExposes = new Map<string, Expose>();

    /** a movement report (`moving`, `motor_state`) or, for a state-only cover, the state itself → `motion` */
    private finishCovers(): void {
        for (const {draft, state, positionAware} of this.covers) {
            const motion = this.motionExposes.get(draft.z2mEndpoint);
            if (motion !== undefined) {
                const map: Record<string, string> = {};
                for (const value of (motion.values ?? []).map(String)) {
                    const v = value.toUpperCase();
                    const kind =
                        v.startsWith('UP') || v.startsWith('OPEN')
                            ? 'opening'
                            : v.startsWith('DOWN') || v.startsWith('CLOS')
                              ? 'closing'
                              : v.startsWith('STOP') || v === 'IDLE'
                                ? 'stopped'
                                : undefined;
                    if (kind !== undefined) {
                        map[value] = kind;
                    }
                }
                draft.bindings.push({attribute: 'WindowCovering.motion', status: this.status(motion, {map})});
                this.unmapped.splice(this.unmapped.indexOf(this.property(motion)), 1);
                continue;
            }
            if (!positionAware && state !== undefined && canRead(state)) {
                const map: Record<string, string> = {};
                for (const value of (state.values ?? []).map(String)) {
                    const v = value.toUpperCase();
                    if (v.startsWith('OPEN')) {
                        map[value] = 'open';
                    } else if (v.startsWith('CLOS')) {
                        map[value] = 'closed';
                    } else if (v.startsWith('STOP')) {
                        map[value] = 'stopped';
                    }
                }
                draft.bindings.push({attribute: 'WindowCovering.motion', status: this.status(state, {map})});
            }
        }
    }

    lock(expose: Expose): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const state = by.get('state');
        if (state === undefined || this.property(state).endsWith('child_lock')) {
            // a child lock is a setting, not a door lock
            for (const feature of features) {
                this.skip(feature);
            }
            return;
        }
        const draft = this.draft(expose.endpoint ?? state.endpoint ?? '');
        this.addType(draft, 'DoorLock');
        const lockState = by.get('lock_state');
        const on = text(state.value_on, 'LOCK');
        const off = text(state.value_off, 'UNLOCK');
        const binding: Record<string, unknown> = {attribute: 'DoorLock.lockState'};
        if (lockState !== undefined && canRead(lockState)) {
            binding.status = this.status(lockState, {
                map: {locked: 'Locked', unlocked: 'Unlocked', not_fully_locked: 'NotFullyLocked'},
            });
        } else if (canRead(state)) {
            binding.status = this.status(state, {map: {[on]: 'Locked', [off]: 'Unlocked'}});
        }
        if (canSet(state)) {
            binding.command = this.command(state, {format: {Locked: on, Unlocked: off}});
        }
        draft.bindings.push(binding as BindingInput);
        for (const feature of features) {
            if (!['state', 'lock_state'].includes(feature.name ?? '')) {
                this.skip(feature);
            }
        }
    }

    climate(expose: Expose): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const draft = this.draft(expose.endpoint ?? features[0]?.endpoint ?? '');
        this.addType(draft, 'Thermostat');
        draft.coalesce = 50;
        const climate = (draft.options.climate ??= {});
        const local = by.get('local_temperature');
        if (local !== undefined) {
            this.bind(draft, 'Thermostat.localTemperature', local, {unit: temperatureUnit(local)});
        }
        const heat = by.get('occupied_heating_setpoint') ?? by.get('current_heating_setpoint');
        if (heat !== undefined) {
            const unit = temperatureUnit(heat);
            this.bind(draft, 'Thermostat.occupiedHeatingSetpoint', heat, {unit}, {unit, round: 1});
            if (heat.value_min !== undefined) {
                climate.minHeat = heat.value_min;
            }
            if (heat.value_max !== undefined) {
                climate.maxHeat = heat.value_max;
            }
        }
        const cool = by.get('occupied_cooling_setpoint') ?? by.get('current_cooling_setpoint');
        if (cool !== undefined) {
            const unit = temperatureUnit(cool);
            this.bind(draft, 'Thermostat.occupiedCoolingSetpoint', cool, {unit}, {unit, round: 1});
            if (cool.value_min !== undefined) {
                climate.minCool = cool.value_min;
            }
            if (cool.value_max !== undefined) {
                climate.maxCool = cool.value_max;
            }
        }
        const mode = by.get('system_mode');
        if (mode !== undefined) {
            const names: Record<string, string> = {
                off: 'Off',
                heat: 'Heat',
                cool: 'Cool',
                auto: 'Auto',
                dry: 'Dry',
                fan_only: 'FanOnly',
                emergency_heating: 'EmergencyHeat',
                precooling: 'Precooling',
            };
            const map: Record<string, string> = {};
            const format: Record<string, string> = {};
            for (const value of (mode.values ?? []).map(String)) {
                const name = names[value];
                if (name !== undefined) {
                    map[value] = name;
                    format[name] = value;
                }
            }
            this.bind(draft, 'Thermostat.systemMode', mode, {map}, {format});
        }
        const running = by.get('running_state');
        if (running !== undefined && canRead(running)) {
            const map: Record<string, string> = {};
            for (const value of (running.values ?? []).map(String)) {
                map[value] = value === 'heat' ? 'heat' : value === 'cool' ? 'cool' : value === 'fan_only' ? 'fan' : '';
            }
            draft.bindings.push({attribute: 'Thermostat.thermostatRunningState', status: this.status(running, {map})});
        }
        const mapped = [
            'local_temperature',
            'occupied_heating_setpoint',
            'current_heating_setpoint',
            'occupied_cooling_setpoint',
            'current_cooling_setpoint',
            'system_mode',
            'running_state',
        ];
        for (const feature of features) {
            if (!mapped.includes(feature.name ?? '')) {
                this.skip(feature);
            }
        }
    }

    fan(expose: Expose): void {
        const features = expose.features ?? [];
        const by = featureMap(features);
        const draft = this.draft(expose.endpoint ?? features[0]?.endpoint ?? '');
        this.addType(draft, 'Fan');
        draft.coalesce = 50;
        const state = by.get('state');
        if (state !== undefined) {
            this.onOff(draft, state);
        }
        const mode = by.get('mode');
        if (mode !== undefined) {
            const values = (mode.values ?? []).map(String);
            const numeric = values.filter((v) => /^\d+$/.test(v)).map(Number);
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
            for (const value of values) {
                const name = names[value];
                if (name !== undefined) {
                    map[value] = name;
                    format[name] = value;
                }
            }
            if (numeric.length >= 2) {
                // numeric steps (`1` … `9`): the percent setting carries them; `off`/`auto` go through the mode
                const max = Math.max(...numeric);
                const percentMap: Record<string, number> = {off: 0};
                for (const n of numeric) {
                    percentMap[String(n)] = Math.round((n * 100) / max);
                }
                this.bind(
                    draft,
                    'FanControl.percentSetting',
                    mode,
                    {map: percentMap},
                    {template: `{{ 'off' if percent == 0 else ((percent * ${max} / 100) | round(0, 'ceil') | int) }}`},
                );
                if (format.Low === undefined && max >= 3) {
                    format.Low = String(Math.ceil(max / 3));
                    format.Medium = String(Math.ceil((2 * max) / 3));
                    format.High = String(max);
                }
            }
            if (Object.keys(map).length > 0) {
                this.bind(draft, 'FanControl.fanMode', mode, {map}, {format});
            }
        }
        const speed = by.get('speed');
        if (speed !== undefined && mode === undefined) {
            const min = speed.value_min ?? 0;
            const max = speed.value_max ?? 100;
            const scale = {from: [min, max] as [number, number], to: [0, 100] as [number, number]};
            this.bind(draft, 'FanControl.percentSetting', speed, {scale, round: 0}, {scale, round: 0});
        }
        for (const feature of features) {
            if (!['state', 'mode', 'speed'].includes(feature.name ?? '')) {
                this.skip(feature);
            }
        }
    }

    /* ----- generic exposes by name ----- */

    numeric(expose: Expose): void {
        if (!canRead(expose)) {
            this.skip(expose);
            return;
        }
        const name = expose.name ?? '';
        const unit = expose.unit;
        const draft = this.draft(expose.endpoint ?? '');
        switch (name) {
            case 'temperature':
                this.addType(draft, 'TemperatureSensor');
                this.bind(draft, 'TemperatureMeasurement.measuredValue', expose, {unit: temperatureUnit(expose)});
                return;
            case 'humidity':
                this.addType(draft, 'HumiditySensor');
                this.bind(draft, 'RelativeHumidityMeasurement.measuredValue', expose, {unit: 'percent100ths'});
                return;
            case 'pressure':
                if (unit === 'hPa' || unit === 'mbar') {
                    this.addType(draft, 'PressureSensor');
                    this.bind(draft, 'PressureMeasurement.measuredValue', expose, {round: 0});
                    return;
                }
                if (unit === 'kPa') {
                    this.addType(draft, 'PressureSensor');
                    this.bind(draft, 'PressureMeasurement.measuredValue', expose, {
                        scale: {from: [0, 1], to: [0, 10], clamp: false},
                        round: 0,
                    });
                    return;
                }
                break;
            case 'illuminance_lux':
            case 'illuminance':
                if (name === 'illuminance_lux' || unit === 'lx') {
                    if (
                        draft.bindings.some(
                            (b) => 'attribute' in b && b.attribute === 'IlluminanceMeasurement.measuredValue',
                        )
                    ) {
                        return;
                    }
                    this.addType(draft, 'LightSensor');
                    this.bind(draft, 'IlluminanceMeasurement.measuredValue', expose, {unit: 'lux'});
                    return;
                }
                break;
            case 'battery': {
                const power = this.draft('', 'power');
                this.addType(power, 'PowerSource');
                this.bind(power, 'PowerSource.batPercentRemaining', expose, {unit: 'halfPercent'});
                return;
            }
            case 'voltage':
                if (this.hasBattery && (unit === 'mV' || unit === 'V')) {
                    const power = this.draft('', 'power');
                    this.addType(power, 'PowerSource');
                    this.bind(power, 'PowerSource.batVoltage', expose, unit === 'V' ? {unit: 'volt'} : {round: 0});
                    return;
                }
                break;
            case 'co2':
                this.addType(draft, 'AirQualitySensor');
                this.bind(draft, 'CarbonDioxideConcentrationMeasurement.measuredValue', expose);
                return;
            case 'co':
                this.addType(draft, 'AirQualitySensor');
                this.bind(draft, 'CarbonMonoxideConcentrationMeasurement.measuredValue', expose);
                return;
            case 'voc':
            case 'formaldehyd':
            case 'formaldehyde': {
                const cluster =
                    name === 'voc'
                        ? 'TotalVolatileOrganicCompoundsConcentrationMeasurement'
                        : 'FormaldehydeConcentrationMeasurement';
                if (unit === 'ppb') {
                    this.addType(draft, 'AirQualitySensor');
                    this.bind(draft, `${cluster}.measuredValue`, expose);
                    return;
                }
                if (unit === 'ppm') {
                    this.addType(draft, 'AirQualitySensor');
                    this.bind(draft, `${cluster}.measuredValue`, expose, {
                        scale: {from: [0, 1], to: [0, 1000], clamp: false},
                    });
                    return;
                }
                break;
            }
            case 'pm25':
            case 'pm10':
            case 'pm1': {
                const cluster =
                    name === 'pm25'
                        ? 'Pm25ConcentrationMeasurement'
                        : name === 'pm10'
                          ? 'Pm10ConcentrationMeasurement'
                          : 'Pm1ConcentrationMeasurement';
                this.addType(draft, 'AirQualitySensor');
                this.bind(draft, `${cluster}.measuredValue`, expose);
                return;
            }
            default:
                break;
        }
        this.skip(expose);
    }

    binary(expose: Expose): void {
        if (!canRead(expose)) {
            this.skip(expose);
            return;
        }
        const on = text(expose.value_on, 'true');
        const off = text(expose.value_off, 'false');
        const draft = this.draft(expose.endpoint ?? '');
        switch (expose.name) {
            case 'contact':
                // zigbee2mqtt's "on" is the open contact; Matter's true is the closed one
                this.addType(draft, 'ContactSensor');
                this.bind(draft, 'BooleanState.stateValue', expose, {map: {[on]: false, [off]: true}});
                return;
            case 'occupancy':
            case 'presence':
                if (draft.bindings.some((b) => 'attribute' in b && b.attribute === 'OccupancySensing.occupancy')) {
                    return;
                }
                this.addType(draft, 'OccupancySensor');
                this.bind(draft, 'OccupancySensing.occupancy', expose, {map: {[on]: true, [off]: false}});
                return;
            case 'water_leak':
                this.addType(draft, 'WaterLeakDetector');
                this.bind(draft, 'BooleanState.stateValue', expose, {map: {[on]: true, [off]: false}});
                return;
            case 'rain':
                this.addType(draft, 'RainSensor');
                this.bind(draft, 'BooleanState.stateValue', expose, {map: {[on]: true, [off]: false}});
                return;
            case 'smoke':
                this.addType(draft, 'SmokeCoAlarm');
                this.addFeature(draft, 'SmokeCoAlarm', 'SmokeAlarm');
                this.bind(draft, 'SmokeCoAlarm.smokeState', expose, {map: {[on]: 'Critical', [off]: 'Normal'}});
                return;
            case 'carbon_monoxide':
                this.addType(draft, 'SmokeCoAlarm');
                this.addFeature(draft, 'SmokeCoAlarm', 'CoAlarm');
                this.bind(draft, 'SmokeCoAlarm.coState', expose, {map: {[on]: 'Critical', [off]: 'Normal'}});
                return;
            case 'battery_low': {
                const power = this.draft('', 'power');
                this.addType(power, 'PowerSource');
                this.bind(power, 'PowerSource.batChargeLevel', expose, {map: {[on]: 'Critical', [off]: 'Ok'}});
                return;
            }
            default:
                this.skip(expose);
        }
    }

    enum(expose: Expose): void {
        if (!canRead(expose)) {
            this.skip(expose);
            return;
        }
        switch (expose.name) {
            case 'air_quality': {
                const draft = this.draft(expose.endpoint ?? '');
                const names: Record<string, string> = {
                    excellent: 'Good',
                    good: 'Fair',
                    moderate: 'Moderate',
                    poor: 'Poor',
                    unhealthy: 'VeryPoor',
                    hazardous: 'ExtremelyPoor',
                    out_of_range: 'Unknown',
                    unknown: 'Unknown',
                };
                const map: Record<string, string> = {};
                for (const value of (expose.values ?? []).map(String)) {
                    const name = names[value];
                    if (name !== undefined) {
                        map[value] = name;
                    }
                }
                this.addType(draft, 'AirQualitySensor');
                this.bind(draft, 'AirQuality.airQuality', expose, {map});
                return;
            }
            case 'action':
                this.actions(expose);
                return;
            case 'moving':
            case 'motor_state':
                this.motionExposes.set(expose.endpoint ?? '', expose);
                this.skip(expose);
                return;
            default:
                this.skip(expose);
        }
    }

    actions(expose: Expose): void {
        const {buttons, ignored} = parseActions(expose.values ?? []);
        for (const value of ignored) {
            this.unmapped.push(`action:${value}`);
        }
        for (const button of buttons) {
            const id = button.name === '' ? 'button' : `button_${endpointId(button.name)}`;
            const draft = this.draft(expose.endpoint ?? '', id);
            this.addType(draft, 'GenericSwitch');
            draft.options.switch = {multiPressMax: Math.max(2, multiPressMax(button))};
            draft.bindings.push({
                event: 'Switch',
                status: this.status(expose, {map: Object.fromEntries(button.kinds)}),
            });
        }
    }

    walk(exposes: Expose[], model: string | undefined): void {
        for (const expose of exposes) {
            switch (expose.type) {
                case 'light':
                    this.light(expose);
                    break;
                case 'switch':
                    this.switch(expose);
                    break;
                case 'cover':
                    this.cover(expose, model);
                    break;
                case 'lock':
                    this.lock(expose);
                    break;
                case 'climate':
                    this.climate(expose);
                    break;
                case 'fan':
                    this.fan(expose);
                    break;
                case 'numeric':
                    this.numeric(expose);
                    break;
                case 'binary':
                    this.binary(expose);
                    break;
                case 'enum':
                    this.enum(expose);
                    break;
                default:
                    this.skip(expose);
            }
        }
        this.finishCovers();
    }

    /** the endpoints in their final form: the main one first, children after; `undefined` when nothing maps */
    endpoints(): EndpointInput[] | undefined {
        const drafts = [...this.drafts.values()].filter((d) => d.types.length > 0);
        const power = drafts.find((d) => d.id === 'power');
        const real = drafts.filter((d) => d !== power);
        const isButton = (d: Draft): boolean => d.types[0] === 'GenericSwitch';
        // the device itself: the device's own endpoint, else the first child that is no button, else (a remote)
        // its unnamed button, else the first button
        let main =
            real.find((d) => d.z2mEndpoint === '' && !isButton(d)) ??
            real.find((d) => !isButton(d)) ??
            real.find((d) => d.id === 'button') ??
            real[0];
        if (main === undefined) {
            return undefined;
        }
        if (power !== undefined) {
            this.addType(main, 'PowerSource');
            main.bindings.push(...power.bindings);
        }
        const ordered = [main, ...real.filter((d) => d !== main)];
        main = ordered[0];
        // child endpoints that share their device type with a sibling (or the device itself) carry a number
        // tag in the Descriptor's TagList: Matter's disambiguation rule, which strict matter.js enforces
        const typeCount = new Map<string, number>();
        for (const draft of ordered) {
            const type = draft.types[0] ?? '';
            typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
        }
        let tag = 0;
        return ordered.map((draft, i) => {
            const endpoint: EndpointInput = {deviceTypes: draft.types, bindings: draft.bindings};
            if (i > 0) {
                endpoint.id = endpointId(draft.id);
                if ((typeCount.get(draft.types[0] ?? '') ?? 0) > 1) {
                    tag++;
                    draft.features.Descriptor = ['TagList'];
                    endpoint.attributes = {
                        Descriptor: {tagList: [{mfgCode: null, namespaceId: NUMBER_NAMESPACE, tag, label: draft.id}]},
                    };
                }
            }
            if (Object.keys(draft.features).length > 0) {
                endpoint.features = draft.features;
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

function featureMap(features: Expose[]): Map<string, Expose> {
    const map = new Map<string, Expose>();
    for (const feature of features) {
        if (feature.name !== undefined && !map.has(feature.name)) {
            map.set(feature.name, feature);
        }
    }
    return map;
}

function temperatureUnit(expose: Expose): 'celsius' | 'fahrenheit' {
    return expose.unit === '°F' ? 'fahrenheit' : 'celsius';
}

function hasBatteryExpose(exposes: Expose[]): boolean {
    return exposes.some((e) => e.type === 'numeric' && e.name === 'battery');
}

/** why a bridge device cannot become a Matter device, or undefined when it can be tried */
export function unsupportedReason(device: BridgeDevice): string | undefined {
    if (device.type === 'Coordinator') {
        return 'the coordinator';
    }
    if (device.supported === false) {
        return 'not supported by zigbee2mqtt';
    }
    if (device.disabled === true) {
        return 'disabled in zigbee2mqtt';
    }
    if (device.interview_completed === false) {
        return 'interview not completed';
    }
    const definition = device.definition;
    if (definition === undefined || definition === null || (definition.exposes ?? []).length === 0) {
        return 'no exposes';
    }
    return undefined;
}

/** the baseline for a device description; undefined when nothing of it maps onto Matter */
export function generateDevice(raw: RawDevice): Generated | undefined {
    const exposes = raw.definition?.exposes ?? [];
    const builder = new Builder(raw.base_topic, raw.friendly_name, hasBatteryExpose(exposes));
    builder.walk(exposes, raw.definition?.model);
    const endpoints = builder.endpoints();
    if (endpoints === undefined) {
        return undefined;
    }
    const device: DeviceInput = {
        name: raw.friendly_name.slice(0, MAX_LABEL),
        ...(label(raw.definition?.vendor) === undefined ? {} : {vendor: label(raw.definition?.vendor)}),
        ...(label(raw.definition?.model) === undefined ? {} : {model: label(raw.definition?.model)}),
        serial: raw.ieee_address.slice(0, MAX_LABEL),
        source: {kind: 'z2m', key: raw.ieee_address, version: rawHash(raw), raw},
        availability: {topic: `${builder.stateTopic}/availability`, template: AVAILABILITY_TEMPLATE},
        endpoints,
    };
    return {device, unmapped: builder.unmapped};
}

/* ----- groups ----- */

export function groupUnion(group: BridgeGroup, devices: ReadonlyMap<string, BridgeDevice>): GroupUnion {
    const union: GroupUnion = {
        kind: undefined,
        brightness: false,
        colorTemp: undefined,
        xy: false,
        hs: false,
        position: false,
        tilt: false,
        members: 0,
    };
    const kinds = new Set<'light' | 'switch' | 'cover'>();
    for (const member of group.members) {
        const device = devices.get(member.ieee_address);
        if (device === undefined) {
            continue;
        }
        union.members++;
        for (const expose of device.definition?.exposes ?? []) {
            const by = featureMap(expose.features ?? []);
            if (expose.type === 'light') {
                kinds.add('light');
                union.brightness ||= by.has('brightness');
                const ct = by.get('color_temp');
                if (ct !== undefined) {
                    const min = ct.value_min;
                    const max = ct.value_max;
                    union.colorTemp = {
                        min: minOf(union.colorTemp?.min, min),
                        max: maxOf(union.colorTemp?.max, max),
                    };
                }
                union.xy ||= by.has('color_xy');
                union.hs ||= by.has('color_hs');
            } else if (expose.type === 'switch') {
                kinds.add('switch');
            } else if (expose.type === 'cover') {
                kinds.add('cover');
                union.position ||= by.has('position');
                union.tilt ||= by.has('tilt');
            }
        }
    }
    union.kind = kinds.has('light')
        ? 'light'
        : kinds.has('switch')
          ? 'switch'
          : kinds.has('cover') && kinds.size === 1
            ? 'cover'
            : undefined;
    return union;
}

const minOf = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
const maxOf = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);

export function rawGroup(group: BridgeGroup, devices: ReadonlyMap<string, BridgeDevice>, baseTopic: string): RawGroup {
    return {
        kind: 'group',
        base_topic: baseTopic,
        id: group.id,
        friendly_name: group.friendly_name,
        members: group.members.map((m) => ({ieee_address: m.ieee_address, endpoint: m.endpoint})),
        union: groupUnion(group, devices),
    };
}

/** a synthetic expose list that describes the union, so the group goes through the same builder */
function unionExposes(union: GroupUnion): Expose[] {
    const all = 7;
    if (union.kind === 'light') {
        const features: Expose[] = [
            {type: 'binary', name: 'state', property: 'state', access: all, value_on: 'ON', value_off: 'OFF'},
        ];
        if (union.brightness) {
            features.push({
                type: 'numeric',
                name: 'brightness',
                property: 'brightness',
                access: all,
                value_min: 0,
                value_max: 254,
            });
        }
        if (union.colorTemp !== undefined) {
            features.push({
                type: 'numeric',
                name: 'color_temp',
                property: 'color_temp',
                access: all,
                ...(union.colorTemp.min === undefined ? {} : {value_min: union.colorTemp.min}),
                ...(union.colorTemp.max === undefined ? {} : {value_max: union.colorTemp.max}),
            });
        }
        if (union.xy) {
            features.push({type: 'composite', name: 'color_xy', property: 'color', access: all});
        }
        if (union.hs) {
            features.push({type: 'composite', name: 'color_hs', property: 'color', access: all});
        }
        return [{type: 'light', features}];
    }
    if (union.kind === 'switch') {
        return [
            {
                type: 'switch',
                features: [
                    {type: 'binary', name: 'state', property: 'state', access: all, value_on: 'ON', value_off: 'OFF'},
                ],
            },
        ];
    }
    if (union.kind === 'cover') {
        const features: Expose[] = [
            {type: 'enum', name: 'state', property: 'state', access: 3, values: ['OPEN', 'CLOSE', 'STOP']},
        ];
        if (union.position) {
            features.push({
                type: 'numeric',
                name: 'position',
                property: 'position',
                access: all,
                value_min: 0,
                value_max: 100,
            });
        }
        if (union.tilt) {
            features.push({type: 'numeric', name: 'tilt', property: 'tilt', access: all, value_min: 0, value_max: 100});
        }
        return [{type: 'cover', features}];
    }
    return [];
}

export function groupUnsupportedReason(union: GroupUnion): string | undefined {
    if (union.members === 0) {
        return 'no members';
    }
    if (union.kind === undefined) {
        return 'the members are neither lights, switches nor covers';
    }
    return undefined;
}

export function generateGroup(raw: RawGroup): Generated | undefined {
    const builder = new Builder(raw.base_topic, raw.friendly_name, false);
    builder.walk(unionExposes(raw.union), undefined);
    const endpoints = builder.endpoints();
    if (endpoints === undefined) {
        return undefined;
    }
    // a group has no `/get`; zigbee2mqtt answers for its members
    for (const endpoint of endpoints) {
        for (const binding of endpoint.bindings ?? []) {
            if (binding.status !== undefined) {
                delete binding.status.get;
            }
        }
    }
    const device: DeviceInput = {
        name: raw.friendly_name.slice(0, MAX_LABEL),
        vendor: 'Zigbee2MQTT',
        model: 'Group',
        serial: `group-${raw.id}`,
        source: {kind: 'z2m', key: `group:${raw.id}`, version: rawHash(raw), raw},
        endpoints,
    };
    return {device, unmapped: builder.unmapped};
}

export function isRaw(value: unknown): value is Raw {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const raw = value as Record<string, unknown>;
    return (
        (raw.kind === 'device' || raw.kind === 'group') &&
        typeof raw.base_topic === 'string' &&
        typeof raw.friendly_name === 'string'
    );
}

/** regenerate the baseline from what `source.raw` holds */
export function generate(raw: Raw): Generated | undefined {
    return raw.kind === 'device' ? generateDevice(raw) : generateGroup(raw);
}
