/* Static validation of a device against @matter/model (the first validation layer): device types exist, clusters
   and attributes exist, the attribute's conformance holds under the endpoint's features, mappings fit the
   attribute's shape (a boolean attribute does not take a number map, an enum map's values are member
   names), commands and event channels exist, templates parse. Pure: no node is built; the strict dry run
   (matter/check.ts) is layer 2. The result is a list of issues with paths the UI can point at. */

import {renderTemplate} from '../engine/template.ts';
import {
    type AttributeInfo,
    type ClusterInfo,
    COMPOSITE_ATTRIBUTES,
    Conformance,
    cluster as clusterInfo,
    deviceType as deviceTypeInfo,
} from './catalog.ts';
import type {Options} from './options.ts';
import {
    type Mapping,
    type DeviceConfig,
    type EndpointConfig,
    type Scalar,
    type StatusHalf,
    mappingTarget,
} from './schema.ts';

export interface Issue {
    level: 'error' | 'warning';
    /** `endpoints[0].mappings[2].status.map` */
    path: string;
    message: string;
}

export interface ValidationResult {
    issues: Issue[];
    errors: Issue[];
    warnings: Issue[];
    ok: boolean;
}

/** the families' implied features, mirrored from src/families so the model stays free of matter.js */
function impliedFeatures(cluster: string, bound: ReadonlySet<string>, options: Options): string[] {
    switch (cluster) {
        case 'ColorControl': {
            const f: string[] = [];
            if (bound.has('ColorControl.colorTemperatureMireds')) {
                f.push('ColorTemperature');
            }
            if (bound.has('ColorControl.colorHs') || bound.has('ColorControl.currentHue')) {
                f.push('HueSaturation');
            }
            if (bound.has('ColorControl.colorXy') || bound.has('ColorControl.currentX')) {
                f.push('Xy');
            }
            return f;
        }
        case 'WindowCovering': {
            const f: string[] = [];
            if (
                bound.has('WindowCovering.currentPositionLiftPercent100ths') ||
                bound.has('WindowCovering.targetPositionLiftPercent100ths')
            ) {
                f.push('Lift', 'PositionAwareLift');
            }
            if (
                bound.has('WindowCovering.currentPositionTiltPercent100ths') ||
                bound.has('WindowCovering.targetPositionTiltPercent100ths')
            ) {
                f.push('Tilt', 'PositionAwareTilt');
            }
            return f.length === 0 ? ['Lift'] : f;
        }
        case 'Thermostat': {
            const f: string[] = [];
            const heating = bound.has('Thermostat.occupiedHeatingSetpoint');
            const cooling = bound.has('Thermostat.occupiedCoolingSetpoint');
            if (heating) {
                f.push('Heating');
            }
            if (cooling) {
                f.push('Cooling');
            }
            if (heating && cooling && bound.has('Thermostat.systemMode')) {
                f.push('AutoMode');
            }
            return f;
        }
        case 'FanControl':
            return options.fan.speedMax > 0 || bound.has('FanControl.speedSetting') ? ['MultiSpeed'] : [];
        case 'Switch':
            return options.switch.kind === 'latching'
                ? ['LatchingSwitch']
                : [
                      'MomentarySwitch',
                      'MomentarySwitchRelease',
                      'MomentarySwitchLongPress',
                      'MomentarySwitchMultiPress',
                  ];
        case 'PowerSource':
            return bound.has('PowerSource.wiredCurrentType') ? ['Wired'] : ['Battery'];
        case 'OccupancySensing':
            return ['PassiveInfrared'];
        default:
            return cluster.endsWith('ConcentrationMeasurement') ? ['NumericMeasurement'] : [];
    }
}

/** the feature set an endpoint's cluster will run with: device type requirements ∪ implied ∪ configured */
export function effectiveFeatures(endpoint: EndpointConfig, cluster: string, bound: ReadonlySet<string>): Set<string> {
    const set = new Set<string>();
    for (const name of endpoint.deviceTypes) {
        for (const requirement of deviceTypeInfo(name)?.clusters ?? []) {
            if (requirement.cluster === cluster) {
                for (const f of requirement.features) {
                    set.add(f);
                }
            }
        }
    }
    for (const f of impliedFeatures(cluster, bound, endpoint.options)) {
        set.add(f);
    }
    const info = clusterInfo(cluster);
    for (const requested of endpoint.features?.[cluster] ?? []) {
        const feature = info?.feature(requested);
        if (feature !== undefined) {
            set.add(feature.title);
        }
    }
    return set;
}

function scalarKind(value: Scalar): 'boolean' | 'number' | 'string' {
    return typeof value as 'boolean' | 'number' | 'string';
}

function checkValueShape(issues: Issue[], path: string, info: AttributeInfo, value: Scalar, what: string): void {
    const kind = scalarKind(value);
    switch (info.metatype) {
        case 'boolean':
            if (kind !== 'boolean') {
                issues.push({
                    level: 'error',
                    path,
                    message: `${what} ${JSON.stringify(value)}: the attribute is a boolean`,
                });
            }
            break;
        case 'integer':
        case 'float':
            if (kind !== 'number') {
                issues.push({
                    level: 'error',
                    path,
                    message: `${what} ${JSON.stringify(value)}: the attribute is a number`,
                });
            } else if (info.metatype === 'integer' && !Number.isInteger(value)) {
                issues.push({
                    level: 'warning',
                    path,
                    message: `${what} ${String(value)} is rounded: the attribute is an integer`,
                });
            } else if (
                (info.min !== undefined && (value as number) < info.min) ||
                (info.max !== undefined && (value as number) > info.max)
            ) {
                issues.push({
                    level: 'warning',
                    path,
                    message: `${what} ${String(value)} is outside ${info.min ?? '…'}–${info.max ?? '…'}`,
                });
            }
            break;
        case 'enum': {
            const members = info.enumMembers ?? new Map<string, number>();
            const known =
                kind === 'number'
                    ? [...members.values()].includes(value as number)
                    : kind === 'string' &&
                      [...members.keys()].some(
                          (m) =>
                              m.toLowerCase() ===
                              String(value)
                                  .toLowerCase()
                                  .replace(/[\s_-]/g, ''),
                      );
            if (!known) {
                issues.push({
                    level: 'error',
                    path,
                    message: `${what} ${JSON.stringify(value)} is not one of ${[...members.keys()].join(', ')}`,
                });
            }
            break;
        }
        case 'bitmap': {
            if (kind === 'string') {
                const fields = (info.bitFields ?? []).map((f) => f.name.toLowerCase());
                for (const name of String(value)
                    .split(/[,\s|]+/)
                    .filter((n) => n !== '')) {
                    if (!fields.includes(name.toLowerCase())) {
                        issues.push({
                            level: 'error',
                            path,
                            message: `${what} "${name}" is not one of ${fields.join(', ')}`,
                        });
                    }
                }
            }
            break;
        }
        case 'string':
            if (kind !== 'string') {
                issues.push({
                    level: 'error',
                    path,
                    message: `${what} ${JSON.stringify(value)}: the attribute is a string`,
                });
            }
            break;
        default:
            break;
    }
}

function checkStatusHalf(issues: Issue[], path: string, half: StatusHalf, info: AttributeInfo | undefined): void {
    if (half.template !== undefined) {
        const rendered = renderTemplate(half.template, {value: '', value_json: {}, topic: half.topic});
        if (!rendered.ok && /template .*: (Parser|Lexer|Syntax|Unexpected)/i.test(rendered.reason)) {
            issues.push({level: 'error', path: `${path}.template`, message: rendered.reason});
        }
    }
    if (
        half.invert === true &&
        half.scale === undefined &&
        half.map === undefined &&
        half.type !== 'boolean' &&
        info?.metatype !== 'boolean'
    ) {
        issues.push({
            level: 'warning',
            path: `${path}.invert`,
            message: 'invert needs a scale for numbers; it only negates booleans otherwise',
        });
    }
    if (info === undefined) {
        return;
    }
    if (half.map !== undefined) {
        for (const [key, value] of Object.entries(half.map)) {
            checkValueShape(issues, `${path}.map["${key}"]`, info, value, 'map value');
        }
    }
    if (half.default !== undefined) {
        checkValueShape(issues, `${path}.default`, info, half.default, 'default');
    }
    if (half.type !== undefined && half.map === undefined) {
        const expected =
            info.metatype === 'boolean'
                ? 'boolean'
                : info.metatype === 'integer' || info.metatype === 'float' || info.metatype === 'enum'
                  ? 'number'
                  : info.metatype === 'string'
                    ? 'string'
                    : undefined;
        // a bitmap takes a boolean (its first field), a number (raw) or a string (field names); an enum its name
        if (expected !== undefined && half.type !== expected && !(info.metatype === 'enum' && half.type === 'string')) {
            issues.push({
                level: 'error',
                path: `${path}.type`,
                message: `type ${half.type}, but the attribute is a ${info.metatype}`,
            });
        }
    }
}

function checkMapping(
    issues: Issue[],
    path: string,
    endpoint: EndpointConfig,
    mapping: Mapping,
    bound: ReadonlySet<string>,
    clusters: ReadonlyMap<string, ClusterInfo>,
): void {
    const {kind, name} = mappingTarget(mapping);
    const [clusterName, member] = name.split('.') as [string, string | undefined];
    const info = clusters.get(clusterName) ?? clusterInfo(clusterName);
    if (info === undefined) {
        issues.push({level: 'error', path, message: `cluster "${clusterName}" is not in the Matter model`});
        return;
    }
    const features = effectiveFeatures(endpoint, clusterName, bound);
    if (!clusters.has(clusterName)) {
        issues.push({
            level: 'warning',
            path,
            message: `cluster ${clusterName} is not part of ${endpoint.deviceTypes.join(', ')}; it is added, controllers may ignore it`,
        });
    }
    if (kind === 'event') {
        if (clusterName !== 'Switch') {
            issues.push({level: 'error', path, message: `event channel "${name}" is unknown; 1.0 knows Switch`});
        } else if (mapping.status === undefined) {
            issues.push({level: 'error', path, message: 'an event mapping needs a status half'});
        }
        return;
    }
    if (member === undefined) {
        issues.push({
            level: 'error',
            path,
            message: `"${name}" needs Cluster.${kind === 'invoke' ? 'command' : 'attribute'}`,
        });
        return;
    }
    if (kind === 'invoke') {
        const command = info.commands.get(member);
        if (command === undefined) {
            issues.push({
                level: 'error',
                path,
                message: `${clusterName} has no command ${member} (it has ${[...info.commands.keys()].join(', ')})`,
            });
        } else if (command.applicability(features) === Conformance.Applicability.None) {
            issues.push({level: 'error', path, message: `${name} needs a feature the endpoint does not enable`});
        }
        if (mapping.command === undefined) {
            issues.push({level: 'error', path, message: 'a command mapping needs a command half'});
        } else if (
            mapping.command.payload === undefined &&
            mapping.command.template === undefined &&
            mapping.command.format === undefined
        ) {
            issues.push({
                level: 'warning',
                path: `${path}.command`,
                message: 'no payload, template or format: the command publishes its name',
            });
        }
        return;
    }
    const composite = COMPOSITE_ATTRIBUTES[name];
    if (composite !== undefined) {
        for (const feature of composite.features) {
            if (!features.has(feature)) {
                issues.push({level: 'error', path, message: `${name} needs the ${clusterName} feature ${feature}`});
            }
        }
        return;
    }
    const attribute = info.attributes.get(member);
    if (attribute === undefined) {
        issues.push({level: 'error', path, message: `${clusterName} has no attribute ${member}`});
        return;
    }
    if (attribute.applicability(features) === Conformance.Applicability.None) {
        issues.push({
            level: 'error',
            path,
            message: `${name} needs a ${clusterName} feature the endpoint does not enable (enabled: ${[...features].join(', ') || 'none'})`,
        });
    }
    if (mapping.status !== undefined) {
        checkStatusHalf(issues, `${path}.status`, mapping.status, attribute);
    }
    if (mapping.command !== undefined) {
        const half = mapping.command;
        if (half.format !== undefined) {
            for (const key of Object.keys(half.format)) {
                if (attribute.metatype === 'enum' && attribute.enumMembers !== undefined) {
                    const members = [...attribute.enumMembers.keys()];
                    if (!members.some((m) => m.toLowerCase() === key.toLowerCase()) && !/^\d+$/.test(key)) {
                        issues.push({
                            level: 'error',
                            path: `${path}.command.format`,
                            message: `"${key}" is not one of ${members.join(', ')}`,
                        });
                    }
                } else if (attribute.metatype === 'boolean' && key !== 'true' && key !== 'false') {
                    issues.push({
                        level: 'warning',
                        path: `${path}.command.format`,
                        message: `"${key}" is neither true nor false`,
                    });
                }
            }
        }
        if (half.template !== undefined) {
            const rendered = renderTemplate(half.template, {value: 0});
            if (!rendered.ok && /(Parser|Lexer|Syntax|Unexpected)/i.test(rendered.reason)) {
                issues.push({level: 'error', path: `${path}.command.template`, message: rendered.reason});
            }
        }
        if (attribute.writable && mapping.status !== undefined && half.optimistic === false) {
            issues.push({
                level: 'warning',
                path: `${path}.command.optimistic`,
                message: `${name} is written by controllers; matter.js applies the write before it is published, so it is optimistic in any case`,
            });
        }
    }
}

/** validate one endpoint */
export function validateEndpoint(endpoint: EndpointConfig, path: string): Issue[] {
    const issues: Issue[] = [];
    const clusters = new Map<string, ClusterInfo>();
    let utilityOnly = true;
    for (const [i, name] of endpoint.deviceTypes.entries()) {
        const info = deviceTypeInfo(name);
        if (info === undefined) {
            issues.push({
                level: 'error',
                path: `${path}.deviceTypes[${i}]`,
                message: `device type "${name}" is not in the Matter model`,
            });
            continue;
        }
        if (info.classification !== 'utility') {
            utilityOnly = false;
        }
        for (const requirement of info.clusters) {
            const cluster = clusterInfo(requirement.cluster);
            if (cluster !== undefined) {
                clusters.set(requirement.cluster, cluster);
            }
        }
    }
    if (utilityOnly && endpoint.deviceTypes.length > 0 && issues.length === 0) {
        issues.push({
            level: 'warning',
            path: `${path}.deviceTypes`,
            message: `${endpoint.deviceTypes.join(', ')} alone is a utility type; controllers show no device for it`,
        });
    }
    for (const [name, requested] of Object.entries(endpoint.features ?? {})) {
        const info = clusterInfo(name);
        if (info === undefined) {
            issues.push({
                level: 'error',
                path: `${path}.features.${name}`,
                message: `cluster "${name}" is not in the Matter model`,
            });
            continue;
        }
        for (const feature of requested) {
            if (info.feature(feature) === undefined) {
                issues.push({
                    level: 'error',
                    path: `${path}.features.${name}`,
                    message: `${name} has no feature "${feature}" (it has ${info.features.map((f) => f.title).join(', ')})`,
                });
            }
        }
    }
    for (const [name, values] of Object.entries(endpoint.attributes ?? {})) {
        const info = clusterInfo(name);
        if (info === undefined) {
            issues.push({
                level: 'error',
                path: `${path}.attributes.${name}`,
                message: `cluster "${name}" is not in the Matter model`,
            });
            continue;
        }
        for (const attribute of Object.keys(values)) {
            if (!info.attributes.has(attribute)) {
                issues.push({
                    level: 'error',
                    path: `${path}.attributes.${name}.${attribute}`,
                    message: `${name} has no attribute ${attribute}`,
                });
            }
        }
    }
    const bound = new Set<string>();
    for (const mapping of endpoint.mappings) {
        bound.add(mappingTarget(mapping).name);
    }
    const seen = new Map<string, number>();
    for (const [i, mapping] of endpoint.mappings.entries()) {
        const mappingPath = `${path}.mappings[${i}]`;
        const key = mappingTarget(mapping).name;
        const first = seen.get(key);
        if (first !== undefined && mappingTarget(mapping).kind !== 'event') {
            issues.push({
                level: 'warning',
                path: mappingPath,
                message: `${key} is bound twice (also mappings[${first}])`,
            });
        } else {
            seen.set(key, i);
        }
        checkMapping(issues, mappingPath, endpoint, mapping, bound, clusters);
    }
    return issues;
}

/** validate a device: every endpoint, plus the device-level checks */
export function validateDevice(device: DeviceConfig): ValidationResult {
    const issues: Issue[] = [];
    for (const [i, endpoint] of device.endpoints.entries()) {
        issues.push(...validateEndpoint(endpoint, `endpoints[${i}]`));
    }
    if (device.availability !== undefined) {
        for (const [i, topic] of device.availability.topics.entries()) {
            if (topic.online === topic.offline) {
                issues.push({
                    level: 'error',
                    path: `availability.topics[${i}]`,
                    message: 'online and offline payloads are the same',
                });
            }
        }
    }
    const errors = issues.filter((i) => i.level === 'error');
    const warnings = issues.filter((i) => i.level === 'warning');
    return {issues, errors, warnings, ok: errors.length === 0};
}

/** validate every device of a config: device key → result (only devices with issues) */
export function validateDevices(devices: Readonly<Record<string, DeviceConfig>>): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>();
    for (const [key, device] of Object.entries(devices)) {
        const result = validateDevice(device);
        if (result.issues.length > 0) {
            results.set(key, result);
        }
    }
    return results;
}
