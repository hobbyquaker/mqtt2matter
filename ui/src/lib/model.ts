/* What the editor knows about the model beyond the catalogue: the attributes a cluster is usually
   bound by (hints for the "clusters" panel, not a rule), which family's options an endpoint shows, the
   enum choices of those options, and the clean-up of a half before it is saved (empty strings are
   absent fields). */

import type {Mapping, CommandHalf, Device, Endpoint, StatusHalf} from './api.ts';
import {isRecord} from './format.ts';

export interface Suggestion {
    kind: 'attribute' | 'invoke' | 'event';
    name: string;
}

/** per cluster, the targets a device of that cluster is usually bound by, in the order to show them */
export const SUGGESTED: Record<string, Suggestion[]> = {
    OnOff: [{kind: 'attribute', name: 'OnOff.onOff'}],
    LevelControl: [{kind: 'attribute', name: 'LevelControl.currentLevel'}],
    ColorControl: [
        {kind: 'attribute', name: 'ColorControl.colorTemperatureMireds'},
        {kind: 'attribute', name: 'ColorControl.colorHs'},
        {kind: 'attribute', name: 'ColorControl.colorXy'},
        {kind: 'attribute', name: 'ColorControl.colorRgb'},
        {kind: 'attribute', name: 'ColorControl.colorMode'},
    ],
    WindowCovering: [
        {kind: 'attribute', name: 'WindowCovering.currentPositionLiftPercent100ths'},
        {kind: 'attribute', name: 'WindowCovering.targetPositionLiftPercent100ths'},
        {kind: 'attribute', name: 'WindowCovering.motion'},
        {kind: 'invoke', name: 'WindowCovering.upOrOpen'},
        {kind: 'invoke', name: 'WindowCovering.downOrClose'},
        {kind: 'invoke', name: 'WindowCovering.stopMotion'},
        {kind: 'attribute', name: 'WindowCovering.currentPositionTiltPercent100ths'},
        {kind: 'attribute', name: 'WindowCovering.targetPositionTiltPercent100ths'},
    ],
    Thermostat: [
        {kind: 'attribute', name: 'Thermostat.localTemperature'},
        {kind: 'attribute', name: 'Thermostat.occupiedHeatingSetpoint'},
        {kind: 'attribute', name: 'Thermostat.occupiedCoolingSetpoint'},
        {kind: 'attribute', name: 'Thermostat.systemMode'},
        {kind: 'attribute', name: 'Thermostat.thermostatRunningState'},
    ],
    DoorLock: [{kind: 'attribute', name: 'DoorLock.lockState'}],
    FanControl: [
        {kind: 'attribute', name: 'FanControl.percentSetting'},
        {kind: 'attribute', name: 'FanControl.percentCurrent'},
        {kind: 'attribute', name: 'FanControl.fanMode'},
        {kind: 'attribute', name: 'FanControl.speedSetting'},
    ],
    Switch: [{kind: 'event', name: 'Switch'}],
    PowerSource: [
        {kind: 'attribute', name: 'PowerSource.batPercentRemaining'},
        {kind: 'attribute', name: 'PowerSource.batVoltage'},
        {kind: 'attribute', name: 'PowerSource.batChargeLevel'},
    ],
    TemperatureMeasurement: [{kind: 'attribute', name: 'TemperatureMeasurement.measuredValue'}],
    RelativeHumidityMeasurement: [{kind: 'attribute', name: 'RelativeHumidityMeasurement.measuredValue'}],
    IlluminanceMeasurement: [{kind: 'attribute', name: 'IlluminanceMeasurement.measuredValue'}],
    PressureMeasurement: [{kind: 'attribute', name: 'PressureMeasurement.measuredValue'}],
    FlowMeasurement: [{kind: 'attribute', name: 'FlowMeasurement.measuredValue'}],
    BooleanState: [{kind: 'attribute', name: 'BooleanState.stateValue'}],
    OccupancySensing: [{kind: 'attribute', name: 'OccupancySensing.occupancy'}],
    AirQuality: [{kind: 'attribute', name: 'AirQuality.airQuality'}],
    SmokeCoAlarm: [
        {kind: 'attribute', name: 'SmokeCoAlarm.smokeState'},
        {kind: 'attribute', name: 'SmokeCoAlarm.coState'},
        {kind: 'attribute', name: 'SmokeCoAlarm.batteryAlert'},
    ],
    Identify: [{kind: 'invoke', name: 'Identify.identify'}],
};

/** the family whose options an endpoint shows, by the clusters it has */
export const FAMILY_CLUSTERS: Record<string, string[]> = {
    onOff: ['OnOff'],
    light: ['OnOff', 'LevelControl', 'ColorControl'],
    cover: ['WindowCovering'],
    climate: ['Thermostat'],
    fan: ['FanControl'],
    switch: ['Switch'],
    powerSource: ['PowerSource'],
};

/** options that are a choice, not free text */
export const OPTION_CHOICES: Record<string, Record<string, string[]>> = {
    light: {onCommandType: ['first', 'last', 'brightness']},
    switch: {kind: ['momentary', 'latching']},
};

/** `Cluster.name` → the cluster */
export function clusterOf(target: string): string {
    return target.split('.')[0] ?? target;
}

export function mappingTarget(mapping: Mapping): Suggestion {
    if (mapping.attribute !== undefined) {
        return {kind: 'attribute', name: mapping.attribute};
    }
    if (mapping.invoke !== undefined) {
        return {kind: 'invoke', name: mapping.invoke};
    }
    return {kind: 'event', name: mapping.event ?? ''};
}

/** the clusters an endpoint's mappings name */
export function boundClusters(endpoint: Endpoint): Set<string> {
    return new Set(endpoint.mappings.map((b) => clusterOf(mappingTarget(b).name)));
}

/** the families whose options apply to an endpoint with these clusters */
export function familiesFor(clusters: Iterable<string>): string[] {
    const set = new Set(clusters);
    return Object.entries(FAMILY_CLUSTERS)
        .filter(([, names]) => names.some((c) => set.has(c)))
        .map(([family]) => family);
}

export function emptyEndpoint(id: string, deviceTypes: string[]): Endpoint {
    return {id, deviceTypes, mappings: [], options: {}, coalesce: 0};
}

export function emptyMapping(target: Suggestion): Mapping {
    const mapping: Mapping = {};
    if (target.kind === 'attribute') {
        mapping.attribute = target.name;
    } else if (target.kind === 'invoke') {
        mapping.invoke = target.name;
    } else {
        mapping.event = target.name;
    }
    return mapping;
}

/** drop empty strings, empty objects and NaN so the half saves as the user meant it */
export function cleanHalf<T extends StatusHalf | CommandHalf>(half: T): T {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(half)) {
        if (value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))) {
            continue;
        }
        if (isRecord(value) && key !== 'scale' && key !== 'get' && key !== 'codec' && Object.keys(value).length === 0) {
            continue;
        }
        if (key === 'get' && isRecord(value) && (value.topic === '' || value.topic === undefined)) {
            continue;
        }
        if (key === 'scale' && isRecord(value)) {
            const from = value.from as unknown[];
            const to = value.to as unknown[];
            if ([...from, ...to].some((n) => typeof n !== 'number' || Number.isNaN(n))) {
                continue;
            }
        }
        out[key] = value;
    }
    return out as T;
}

export function cleanMapping(mapping: Mapping): Mapping {
    const out: Mapping = {...mapping};
    if (out.status !== undefined) {
        out.status = cleanHalf(out.status);
    }
    if (out.command !== undefined) {
        out.command = cleanHalf(out.command);
    }
    if (out.comment === '') {
        delete out.comment;
    }
    return out;
}

/** the device as the server takes it: halves cleaned, empty availability dropped */
export function cleanDevice(device: Device): Device {
    const out = JSON.parse(JSON.stringify(device)) as Device;
    for (const endpoint of out.endpoints) {
        endpoint.mappings = endpoint.mappings.map(cleanMapping);
        if (endpoint.features !== undefined && Object.keys(endpoint.features).length === 0) {
            delete endpoint.features;
        }
        if (endpoint.attributes !== undefined && Object.keys(endpoint.attributes).length === 0) {
            delete endpoint.attributes;
        }
    }
    if (out.availability !== undefined) {
        out.availability.topics = out.availability.topics.filter((topic) => topic.topic !== '');
        if (out.availability.topics.length === 0) {
            delete out.availability;
        } else {
            for (const topic of out.availability.topics) {
                if (topic.extract === '') {
                    delete topic.extract;
                }
                if (topic.template === '') {
                    delete topic.template;
                }
            }
        }
    }
    for (const key of ['vendor', 'model', 'serial', 'bridge'] as const) {
        if (out[key] === '') {
            delete out[key];
        }
    }
    return out;
}

/** a map value typed as the user wrote it: true/false, a number, else the text */
export function scalarOf(text: string): boolean | number | string {
    if (text === 'true') {
        return true;
    }
    if (text === 'false') {
        return false;
    }
    if (text.trim() !== '' && !Number.isNaN(Number(text))) {
        return Number(text);
    }
    return text;
}

/** the user's text for a Matter value in the command preview */
export function valueOf(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed === '') {
        return '';
    }
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return trimmed;
    }
}
