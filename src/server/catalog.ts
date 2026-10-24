/* The catalogue as JSON for the editor's pickers: device types with their cluster requirements, a
   cluster's attributes (with type, range, enum members, bitmap fields, writability), commands and
   events, the composite attributes the families own, the units. Everything comes from src/model, which
   reads @matter/model. */

import {Matter} from '@matter/main/model';

import {COMPOSITE_ATTRIBUTES, type ClusterInfo, cluster, deviceType, deviceTypeNames} from '../model/catalog.ts';
import {UnitSchema} from '../model/schema.ts';
import {HttpError} from './http.ts';

export interface DeviceTypeJson {
    name: string;
    id: number;
    classification: string;
    clusters: {cluster: string; mandatory: boolean; features: readonly string[]}[];
}

export interface AttributeJson {
    name: string;
    id: number;
    metatype: string;
    nullable: boolean;
    writable: boolean;
    enumMembers?: Record<string, number>;
    bitFields?: {name: string; bit: number}[];
    min?: number;
    max?: number;
    /** `M` mandatory, `O` optional, `X` not applicable under the cluster's default features … */
    conformance: string;
}

export interface ClusterJson {
    name: string;
    id: number;
    features: {code: string; title: string}[];
    attributes: AttributeJson[];
    commands: {name: string; id: number; fields: readonly string[]}[];
    events: readonly string[];
}

let deviceTypesCache: DeviceTypeJson[] | undefined;

export function deviceTypesJson(): DeviceTypeJson[] {
    if (deviceTypesCache === undefined) {
        deviceTypesCache = [];
        for (const name of deviceTypeNames()) {
            const info = deviceType(name);
            if (info === undefined) {
                continue;
            }
            deviceTypesCache.push({
                name: info.name,
                id: info.id,
                classification: info.classification,
                clusters: info.clusters.map((c) => ({
                    cluster: c.cluster,
                    mandatory: c.mandatory,
                    features: c.features,
                })),
            });
        }
    }
    return deviceTypesCache;
}

export function clusterNames(): string[] {
    return Matter.clusters
        .filter((c) => c.id !== undefined)
        .map((c) => c.name)
        .sort();
}

const clusterCache = new Map<string, ClusterJson>();

function applicabilityCode(info: ClusterInfo, applicability: (features: Iterable<string>) => unknown): string {
    const value = applicability(info.features.map((f) => f.title));
    return String(value);
}

export function clusterJson(name: string): ClusterJson {
    const cached = clusterCache.get(name);
    if (cached !== undefined) {
        return cached;
    }
    const info = cluster(name);
    if (info === undefined) {
        throw new HttpError(404, `unknown cluster ${name}`);
    }
    const attributes: AttributeJson[] = [];
    for (const a of info.attributes.values()) {
        const json: AttributeJson = {
            name: a.name,
            id: a.id,
            metatype: a.metatype,
            nullable: a.nullable,
            writable: a.writable,
            conformance: applicabilityCode(info, (features) => a.applicability(features)),
        };
        if (a.enumMembers !== undefined) {
            json.enumMembers = Object.fromEntries(a.enumMembers);
        }
        if (a.bitFields !== undefined) {
            json.bitFields = [...a.bitFields];
        }
        if (a.min !== undefined) {
            json.min = a.min;
        }
        if (a.max !== undefined) {
            json.max = a.max;
        }
        attributes.push(json);
    }
    const json: ClusterJson = {
        name: info.name,
        id: info.id,
        features: info.features.map((f) => ({code: f.code, title: f.title})),
        attributes,
        commands: [...info.commands.values()].map((c) => ({name: c.name, id: c.id, fields: c.fields})),
        events: info.events,
    };
    clusterCache.set(name, json);
    return json;
}

export function catalogJson(): {
    deviceTypes: DeviceTypeJson[];
    clusters: string[];
    composites: typeof COMPOSITE_ATTRIBUTES;
    units: readonly string[];
    eventChannels: string[];
} {
    return {
        deviceTypes: deviceTypesJson(),
        clusters: clusterNames(),
        composites: COMPOSITE_ATTRIBUTES,
        units: UnitSchema.options,
        eventChannels: ['Switch'],
    };
}
