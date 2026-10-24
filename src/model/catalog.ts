/* Lookups into @matter/model: device types, clusters, their features, attributes, commands and events,
   with what the editor and the validator need (metatype, nullability, writability, enum members, bitmap
   fields, ranges, conformance under a feature set). Nothing here is hand-maintained; the model is the
   catalogue (study §2.1). The few names the families add on top of the model — composite attributes such
   as `ColorControl.colorHs` — are listed at the end so the validator knows them. */

import {
    type AttributeModel,
    type ClusterModel,
    type CommandModel,
    Conformance,
    type DeviceTypeModel,
    FeatureSet,
    Matter,
    type Model,
} from '@matter/main/model';

export type Metatype =
    | 'any'
    | 'boolean'
    | 'bitmap'
    | 'enum'
    | 'integer'
    | 'float'
    | 'bytes'
    | 'array'
    | 'object'
    | 'string'
    | 'date'
    | 'duration';

export interface FeatureInfo {
    /** the specification's code, e.g. `LT` */
    code: string;
    /** the name matter.js and the config use, e.g. `Lighting` */
    title: string;
}

export interface AttributeInfo {
    /** lower camel case as matter.js names it, e.g. `currentLevel` */
    name: string;
    id: number;
    metatype: Metatype;
    nullable: boolean;
    writable: boolean;
    /** enum values by name (the model's PascalCase) */
    enumMembers: ReadonlyMap<string, number> | undefined;
    /** bitmap fields by name (lower camel, as matter.js' state object keys) with their bit */
    bitFields: readonly {name: string; bit: number}[] | undefined;
    min: number | undefined;
    max: number | undefined;
    /** the conformance under the cluster's feature set (titles or codes) */
    applicability(features: Iterable<string>): Conformance.Applicability;
}

export interface CommandInfo {
    /** lower camel case, e.g. `goToLiftPercentage` */
    name: string;
    id: number;
    /** request field names in lower camel case, in order */
    fields: readonly string[];
    applicability(features: Iterable<string>): Conformance.Applicability;
}

export interface ClusterInfo {
    name: string;
    id: number;
    /** the behavior id matter.js uses as the state key, e.g. `onOff` */
    behaviorId: string;
    features: readonly FeatureInfo[];
    attributes: ReadonlyMap<string, AttributeInfo>;
    commands: ReadonlyMap<string, CommandInfo>;
    events: readonly string[];
    /** `Lighting` or `LT` → `Lighting`; undefined for an unknown feature */
    feature(nameOrCode: string): FeatureInfo | undefined;
}

export interface DeviceTypeClusterRequirement {
    cluster: string;
    mandatory: boolean;
    /** feature titles the device type requires on this cluster (e.g. `Lighting` on a light's OnOff) */
    features: readonly string[];
}

export interface DeviceTypeInfo {
    name: string;
    id: number;
    revision: number;
    classification: string;
    /** the server clusters the device type names, mandatory and optional */
    clusters: readonly DeviceTypeClusterRequirement[];
}

export function lowerCamel(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
}

export function upperCamel(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

const clusterCache = new Map<string, ClusterInfo | null>();
const deviceTypeCache = new Map<string, DeviceTypeInfo | null>();

function featureContext(cluster: ClusterModel, enabled: Iterable<string>): Conformance.FeatureContext {
    const byTitle = new Map<string, string>();
    for (const f of cluster.features) {
        byTitle.set(f.title ?? f.name, f.name);
        byTitle.set(f.name, f.name);
    }
    const codes: string[] = [];
    for (const name of enabled) {
        const code = byTitle.get(name);
        if (code !== undefined) {
            codes.push(code);
        }
    }
    return {
        definedFeatures: new FeatureSet(cluster.features.map((f) => f.name)),
        supportedFeatures: new FeatureSet(codes),
    };
}

function constraintBound(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function attributeInfo(cluster: ClusterModel, attribute: AttributeModel): AttributeInfo {
    const metatype = (attribute.effectiveMetatype ?? 'any') as Metatype;
    let enumMembers: Map<string, number> | undefined;
    let bitFields: {name: string; bit: number}[] | undefined;
    if (metatype === 'enum') {
        enumMembers = new Map();
        for (const member of attribute.members) {
            if (typeof member.id === 'number') {
                enumMembers.set(member.name, member.id);
            }
        }
    } else if (metatype === 'bitmap') {
        bitFields = [];
        for (const member of attribute.members) {
            const bit = constraintBound(member.constraint.value) ?? constraintBound(member.constraint.min);
            if (bit !== undefined) {
                bitFields.push({name: lowerCamel(member.name), bit});
            }
        }
    }
    const constraint = attribute.effectiveConstraint;
    return {
        name: lowerCamel(attribute.name),
        id: attribute.id,
        metatype,
        nullable: attribute.effectiveQuality.nullable === true,
        writable: attribute.access.writable,
        enumMembers,
        bitFields,
        min: constraintBound(constraint.min),
        max: constraintBound(constraint.max),
        applicability: (features) => attribute.conformance.applicabilityFor(featureContext(cluster, features)),
    };
}

function commandInfo(cluster: ClusterModel, command: CommandModel): CommandInfo {
    return {
        name: lowerCamel(command.name),
        id: command.id,
        fields: (command.children as unknown as {name: string}[]).map((f) => lowerCamel(f.name)),
        applicability: (features) => command.conformance.applicabilityFor(featureContext(cluster, features)),
    };
}

/** the cluster by its PascalCase name (`OnOff`, `LevelControl`), or undefined */
export function cluster(name: string): ClusterInfo | undefined {
    const cached = clusterCache.get(name);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const model = Matter.clusters(name);
    if (model?.id === undefined) {
        clusterCache.set(name, null);
        return undefined;
    }
    const features: FeatureInfo[] = model.features.map((f) => ({code: f.name, title: f.title ?? f.name}));
    const attributes = new Map<string, AttributeInfo>();
    for (const attribute of model.attributes) {
        if (attribute.isGlobal) {
            continue;
        }
        const info = attributeInfo(model, attribute);
        attributes.set(info.name, info);
    }
    const commands = new Map<string, CommandInfo>();
    for (const command of model.commands) {
        if (String(command.direction) !== 'request') {
            continue;
        }
        const info = commandInfo(model, command);
        commands.set(info.name, info);
    }
    const info: ClusterInfo = {
        name: model.name,
        id: model.id,
        behaviorId: lowerCamel(model.name),
        features,
        attributes,
        commands,
        events: model.events.map((e) => lowerCamel(e.name)),
        feature: (nameOrCode) =>
            features.find((f) => f.title === nameOrCode) ?? features.find((f) => f.code === nameOrCode),
    };
    clusterCache.set(name, info);
    return info;
}

function requirementFeatures(clusterModel: ClusterModel | undefined, requirement: Model): string[] {
    if (clusterModel === undefined) {
        return [];
    }
    const titles: string[] = [];
    for (const child of requirement.children) {
        const feature = clusterModel.features.find((f) => f.name === child.name);
        if (feature === undefined) {
            continue;
        }
        const conformance = (child as {conformance?: Conformance}).conformance;
        if (conformance?.isMandatory) {
            titles.push(feature.title ?? feature.name);
        }
    }
    return titles;
}

/** the device type by its name (`OnOffLight`, `PowerSource`), or undefined */
export function deviceType(name: string): DeviceTypeInfo | undefined {
    const cached = deviceTypeCache.get(name);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const model: DeviceTypeModel | undefined = Matter.deviceTypes(name);
    if (model === undefined) {
        deviceTypeCache.set(name, null);
        return undefined;
    }
    const clusters: DeviceTypeClusterRequirement[] = [];
    for (const requirement of model.requirements) {
        if ((requirement.element as string) !== 'serverCluster' || requirement.name === 'Descriptor') {
            continue;
        }
        const conformance = String(requirement.conformance);
        if (conformance === 'X' || conformance.startsWith('D')) {
            continue;
        }
        clusters.push({
            cluster: requirement.name,
            mandatory: requirement.conformance.isMandatory,
            features: requirementFeatures(Matter.clusters(requirement.name), requirement as unknown as Model),
        });
    }
    const info: DeviceTypeInfo = {
        name: model.name,
        id: model.id,
        revision: model.revision,
        classification: String(model.classification),
        clusters,
    };
    deviceTypeCache.set(name, info);
    return info;
}

/** every device type name the model knows, for the editor's picker */
export function deviceTypeNames(): string[] {
    return Matter.deviceTypes.map((d) => d.name).sort();
}

export {Conformance};

/** command keys whose confirmation arrives on another attribute's status: decides the default of `optimistic` */
export const RELATED_STATUS: Readonly<Record<string, readonly string[]>> = {
    'WindowCovering.targetPositionLiftPercent100ths': [
        'WindowCovering.currentPositionLiftPercent100ths',
        'WindowCovering.motion',
    ],
    'WindowCovering.targetPositionTiltPercent100ths': ['WindowCovering.currentPositionTiltPercent100ths'],
    'WindowCovering.upOrOpen': ['WindowCovering.currentPositionLiftPercent100ths', 'WindowCovering.motion'],
    'WindowCovering.downOrClose': ['WindowCovering.currentPositionLiftPercent100ths', 'WindowCovering.motion'],
    'WindowCovering.stopMotion': ['WindowCovering.currentPositionLiftPercent100ths', 'WindowCovering.motion'],
    'FanControl.fanMode': ['FanControl.percentCurrent', 'FanControl.percentSetting'],
    'FanControl.percentSetting': ['FanControl.percentCurrent'],
    'FanControl.speedSetting': ['FanControl.speedCurrent', 'FanControl.percentCurrent'],
    'DoorLock.lockState': [],
};

/** composite attributes the families own on top of the model; the value is an object of these fields */
export const COMPOSITE_ATTRIBUTES: Readonly<
    Record<string, {cluster: string; fields: readonly string[]; features: readonly string[]; description: string}>
> = {
    'ColorControl.colorHs': {
        cluster: 'ColorControl',
        fields: ['hue', 'saturation'],
        features: ['HueSaturation'],
        description: 'hue 0–360° and saturation 0–100 %',
    },
    'ColorControl.colorXy': {
        cluster: 'ColorControl',
        fields: ['x', 'y'],
        features: ['Xy'],
        description: 'CIE x and y, 0–1',
    },
    'ColorControl.colorRgb': {
        cluster: 'ColorControl',
        fields: ['r', 'g', 'b'],
        features: [],
        description: 'red, green, blue 0–255 (converted to the colour features the endpoint has)',
    },
    'WindowCovering.motion': {
        cluster: 'WindowCovering',
        fields: [],
        features: [],
        description: 'opening, closing, stopped, open or closed',
    },
};
