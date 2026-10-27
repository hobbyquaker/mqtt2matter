/* The endpoint type for an endpoint of the model, built from matter.js' own device definitions — every
   `<Name>Device` it ships plus the utility `PowerSource` — and @matter/model: the first device type is the
   endpoint's type, the others are added to the Descriptor's device type list and their mandatory clusters
   merged; the clusters are the device types' mandatory ones, the optional ones a mapping or the config
   names, and any other cluster a mapping names; each cluster's server is the family's class where there
   is one (it routes controller commands), else matter.js' default; its features are the union of what the
   device type requires (`OnOffServer.with("Lighting")` on lights), what the mappings imply and what the
   config asks for. No table of device types lives here. */

import type {Behavior, EndpointType} from '@matter/main';
import * as behaviors from '@matter/main/behaviors';
import {BridgedDeviceBasicInformationServer} from '@matter/main/behaviors/bridged-device-basic-information';
import * as devices from '@matter/main/devices';
import * as endpoints from '@matter/main/endpoints';

import {familyFor} from '../families/index.ts';
import {CLUSTER_DEFAULTS} from './cluster-defaults.ts';
import {type ClusterInfo, cluster as clusterInfo, deviceType as deviceTypeInfo, upperCamel} from '../model/catalog.ts';
import type {Options} from '../model/options.ts';
import {type EndpointConfig, mappingTarget} from '../model/schema.ts';

interface DeviceDefinition {
    name: string;
    deviceType: number;
    deviceRevision: number;
    behaviors: Record<string, Behavior.Type>;
    requirements: {
        server?: {
            mandatory?: Record<string, Behavior.Type>;
            optional?: Record<string, Behavior.Type>;
        };
    };
    with(...behaviors: Behavior.Type[]): EndpointType;
}

type ServerWithFeatures = Behavior.Type & {
    features?: Record<string, boolean>;
    schema?: {
        attributes: {
            name: string;
            conformance: unknown;
            constraint: {min?: unknown; max?: unknown};
            default?: unknown;
        }[];
    };
    with(...features: string[]): Behavior.Type;
    alter?(changes: unknown): Behavior.Type;
};

interface AttributeAlteration {
    optional?: boolean;
    min?: number;
    max?: number;
    default?: unknown;
}

/**
 * What a device type's requirement class changed on the default server (`remainingTime` mandatory on a
 * colour light, `currentLevel` 1–254 on a dimmable one), read off its altered schema, so the family's
 * server gets the same alterations.
 */
function alterationsOf(
    requirement: ServerWithFeatures | undefined,
    base: ServerWithFeatures,
): Record<string, AttributeAlteration> {
    const changes: Record<string, AttributeAlteration> = {};
    if (requirement?.schema === undefined || Object.is(requirement, base)) {
        return changes;
    }
    const baseAttributes = new Map(base.schema.attributes.map((a) => [a.name, a]));
    for (const attribute of requirement.schema.attributes) {
        const original = baseAttributes.get(attribute.name);
        if (original === undefined) {
            continue;
        }
        const change: AttributeAlteration = {};
        if (String(attribute.conformance) === 'M' && String(original.conformance) !== 'M') {
            change.optional = false;
        }
        if (typeof attribute.constraint.min === 'number' && attribute.constraint.min !== original.constraint.min) {
            change.min = attribute.constraint.min;
        }
        if (typeof attribute.constraint.max === 'number' && attribute.constraint.max !== original.constraint.max) {
            change.max = attribute.constraint.max;
        }
        if (
            attribute.default !== undefined &&
            attribute.default !== original.default &&
            typeof attribute.default !== 'object'
        ) {
            change.default = attribute.default;
        }
        if (Object.keys(change).length > 0) {
            changes[lowerFirst(attribute.name)] = change;
        }
    }
    return changes;
}

function lowerFirst(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
}

/** the matter.js device definition for a model device type name, or undefined */
export function deviceDefinition(name: string): DeviceDefinition | undefined {
    const fromDevices = (devices as Record<string, unknown>)[`${name}Device`];
    if (fromDevices !== undefined) {
        return fromDevices as DeviceDefinition;
    }
    const fromEndpoints = (endpoints as Record<string, unknown>)[`${name}Endpoint`];
    if (fromEndpoints !== undefined && name !== 'Root' && name !== 'Aggregator') {
        return fromEndpoints as DeviceDefinition;
    }
    return undefined;
}

/** the device type names this build can construct */
export function supportedDeviceTypes(): string[] {
    const names = new Set<string>();
    for (const key of Object.keys(devices)) {
        if (key.endsWith('Device') && !key.endsWith('DeviceDefinition')) {
            names.add(key.slice(0, -'Device'.length));
        }
    }
    names.add('PowerSource');
    names.add('ElectricalSensor');
    return [...names].sort();
}

function featureTitles(server: ServerWithFeatures | undefined): string[] {
    if (server?.features === undefined) {
        return [];
    }
    return Object.entries(server.features)
        .filter(([, on]) => on)
        .map(([key]) => upperCamel(key));
}

export interface BuiltEndpoint {
    type: EndpointType;
    /** the enabled feature titles per cluster */
    features: ReadonlyMap<string, ReadonlySet<string>>;
    /** behavior options per behavior id, for the Endpoint's construction */
    defaults: Record<string, Record<string, unknown>>;
    /** the Descriptor's device type list */
    deviceTypeList: {deviceType: number; revision: number}[];
    /** cluster name → behavior id of every cluster on the endpoint */
    clusters: ReadonlyMap<string, string>;
}

/** the keys every mapping of the endpoint names (`Cluster.attribute`, `Cluster.command`, `Cluster`) */
export function boundKeys(endpoint: EndpointConfig): Set<string> {
    const keys = new Set<string>();
    for (const mapping of endpoint.mappings) {
        keys.add(mappingTarget(mapping).name);
    }
    return keys;
}

function clustersNamed(endpoint: EndpointConfig): Set<string> {
    const names = new Set<string>();
    for (const key of boundKeys(endpoint)) {
        names.add(key.split('.')[0] ?? key);
    }
    for (const name of Object.keys(endpoint.features ?? {})) {
        names.add(name);
    }
    for (const name of Object.keys(endpoint.attributes ?? {})) {
        names.add(name);
    }
    return names;
}

/**
 * Build the endpoint type and its construction defaults for one endpoint of the model. Throws when a
 * device type or cluster is unknown; conformance beyond that is the validator's and matter.js' business.
 */
export function buildEndpoint(
    endpoint: EndpointConfig,
    options: Options = endpoint.options,
    {bridged = false} = {},
): BuiltEndpoint {
    const definitions = endpoint.deviceTypes.map((name) => {
        const definition = deviceDefinition(name);
        const info = deviceTypeInfo(name);
        if (definition === undefined || info === undefined) {
            throw new Error(
                `device type "${name}" is not known to matter.js ${definition === undefined ? '' : '(model)'}`.trim(),
            );
        }
        return {definition, info};
    });
    const [primary, ...others] = definitions;
    if (primary === undefined) {
        throw new Error('an endpoint needs at least one device type');
    }
    const bound = boundKeys(endpoint);
    const named = clustersNamed(endpoint);

    // the clusters: cluster name → the server the device type requires (features and alterations included)
    const required = new Map<string, {server: ServerWithFeatures | undefined; info: ClusterInfo}>();
    const add = (name: string, server: Behavior.Type | undefined): void => {
        const info = clusterInfo(name);
        if (info === undefined) {
            throw new Error(`cluster "${name}" is not known to the Matter model`);
        }
        const existing = required.get(name);
        if (existing === undefined || (existing.server === undefined && server !== undefined)) {
            required.set(name, {server: server as ServerWithFeatures | undefined, info});
        }
    };
    for (const {definition} of definitions) {
        for (const [name, server] of Object.entries(definition.requirements.server?.mandatory ?? {})) {
            add(name, server);
        }
    }
    for (const {definition} of definitions) {
        for (const [name, server] of Object.entries(definition.requirements.server?.optional ?? {})) {
            if (named.has(name)) {
                add(name, server);
            }
        }
    }
    for (const name of named) {
        if (!required.has(name)) {
            const server = (behaviors as Record<string, unknown>)[`${name}Server`] as Behavior.Type | undefined;
            if (server === undefined) {
                throw new Error(`cluster "${name}" has no server in matter.js`);
            }
            add(name, server);
        }
    }

    // the features per cluster: device type requirement ∪ family ∪ config
    const features = new Map<string, Set<string>>();
    for (const [name, {server, info}] of required) {
        const set = new Set<string>(featureTitles(server));
        const family = familyFor(name);
        for (const title of family?.features?.(bound, options) ?? []) {
            set.add(title);
        }
        for (const requested of endpoint.features?.[name] ?? []) {
            const feature = info.feature(requested);
            if (feature === undefined) {
                throw new Error(
                    `cluster ${name} has no feature "${requested}" (it has ${info.features.map((f) => f.title).join(', ')})`,
                );
            }
            set.add(feature.title);
        }
        if (set.size === 0) {
            for (const title of CLUSTER_DEFAULTS[name]?.features ?? []) {
                set.add(title);
            }
        }
        features.set(name, set);
    }

    // the servers: the family's class with the features, else the device type's, else the default
    const servers: Behavior.Type[] = [];
    const clusters = new Map<string, string>();
    const defaults: Record<string, Record<string, unknown>> = {};
    for (const [name, {server, info}] of required) {
        const family = familyFor(name);
        const set = features.get(name) ?? new Set<string>();
        let chosen: ServerWithFeatures;
        if (family !== undefined) {
            chosen = family.server as ServerWithFeatures;
            if (set.size > 0) {
                chosen = chosen.with(...set) as ServerWithFeatures;
            }
            const alterations = alterationsOf(server, family.server as ServerWithFeatures);
            if (Object.keys(alterations).length > 0 && chosen.alter !== undefined) {
                chosen = chosen.alter({attributes: alterations}) as ServerWithFeatures;
            }
        } else {
            chosen = server ?? ((behaviors as Record<string, unknown>)[`${name}Server`] as ServerWithFeatures);
            const own = new Set(featureTitles(chosen));
            if ([...set].some((f) => !own.has(f))) {
                chosen = chosen.with(...set) as ServerWithFeatures;
            }
        }
        servers.push(chosen);
        clusters.set(name, info.behaviorId);
        const clusterDefaults = CLUSTER_DEFAULTS[name]?.attributes?.(set);
        const familyDefaults = family?.defaults?.(set, options);
        const configured = endpoint.attributes?.[name];
        if (clusterDefaults !== undefined || familyDefaults !== undefined || configured !== undefined) {
            defaults[info.behaviorId] = {...clusterDefaults, ...familyDefaults, ...configured};
        }
    }

    const deviceTypeList = definitions.map(({info}) => ({deviceType: info.id, revision: info.revision}));
    let type = primary.definition.with(...servers);
    if (bridged) {
        // the device's own endpoint under the aggregator: BridgedDeviceBasicInformation adds the BridgedNode type
        type = (type as unknown as DeviceDefinition).with(BridgedDeviceBasicInformationServer);
        clusters.set('BridgedDeviceBasicInformation', 'bridgedDeviceBasicInformation');
    }
    if (others.length > 0) {
        defaults.descriptor = {...defaults.descriptor, deviceTypeList};
    }
    return {type, features, defaults, deviceTypeList, clusters};
}
