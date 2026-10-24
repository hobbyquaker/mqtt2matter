/* The strict dry run (study §2.5, layer 2): build every enabled device in a throw-away ServerNode of its
   own Environment with `endpoint.validation=strict` and in-memory storage, never going online, and
   collect what matter.js refuses — construction errors and the DeviceTypeConformanceService's
   violations. `mqtt2matter --check` prints the result; the UI's check button (phase 3) calls it. */

import {
    Endpoint,
    Environment,
    Logger as MatterLogger,
    MemoryStorageDriver,
    ServerNode,
    StorageService,
    VariableService,
    VendorId,
} from '@matter/main';
import {AggregatorEndpoint} from '@matter/main/endpoints/aggregator';
import {DeviceTypeConformanceService} from '@matter/node';

import type {Config} from '../config/schema.ts';
import {type Issue, validateDevice} from '../model/validate.ts';
import {nestedErrors} from './bridge.ts';
import {MATTER_LEVELS} from './node-manager.ts';
import {buildEndpoint} from './device-types.ts';
import {
    BRIDGE_PRODUCT_LABEL,
    bridgedInformation,
    childEndpointId,
    deviceEndpointId,
    HARDWARE_VERSION,
    uniqueId,
    VENDOR_NAME,
} from './ids.ts';

export interface CheckResult {
    /** device key → the issues, static and from the dry run */
    devices: Map<string, Issue[]>;
    ok: boolean;
}

let counter = 0;

/** a child of the process environment with its own variables (strict validation) and memory storage */
function checkEnvironment(): Environment {
    const env = new Environment(`mqtt2matter-check-${++counter}`, Environment.default);
    const vars = new VariableService(env);
    vars.set('endpoint.validation', 'strict');
    const storage = new StorageService(env);
    storage.registerDriver(MemoryStorageDriver);
    storage.defaultDriver = 'memory';
    storage.configuredDriver = 'memory';
    return env;
}

/** check every enabled device of the config; nothing goes online */
export async function checkConfig(config: Config): Promise<CheckResult> {
    const devices = new Map<string, Issue[]>();
    MatterLogger.level = MATTER_LEVELS[config.log.matter];
    const env = checkEnvironment();
    const node = await ServerNode.create({
        id: 'check',
        environment: env,
        network: {port: 0},
        commissioning: {passcode: 20202021, discriminator: 3840},
        productDescription: {name: 'check', deviceType: AggregatorEndpoint.deviceType},
        basicInformation: {
            vendorName: VENDOR_NAME,
            vendorId: VendorId(config.vendorId),
            nodeLabel: 'check',
            productName: VENDOR_NAME,
            productLabel: BRIDGE_PRODUCT_LABEL,
            productId: config.productId,
            serialNumber: 'check',
            uniqueId: uniqueId('check', 'check'),
            softwareVersion: 1,
            hardwareVersion: HARDWARE_VERSION,
        },
    });
    try {
        const aggregator = new Endpoint(AggregatorEndpoint, {id: 'aggregator'});
        await node.add(aggregator);
        const conformance = node.env.get(DeviceTypeConformanceService);
        for (const [key, device] of Object.entries(config.devices)) {
            const issues: Issue[] = [...validateDevice(device).issues];
            if (device.enabled) {
                const [main, ...children] = device.endpoints;
                if (main !== undefined) {
                    try {
                        const parts: Endpoint[] = [];
                        for (const child of children) {
                            const built = buildEndpoint(child);
                            parts.push(
                                new Endpoint(built.type, {id: childEndpointId(key, child.id), ...built.defaults}),
                            );
                        }
                        const built = buildEndpoint(main, main.options, {bridged: true});
                        const endpoint = new Endpoint(built.type, {
                            id: deviceEndpointId(key),
                            parts,
                            ...built.defaults,
                            bridgedDeviceBasicInformation: bridgedInformation(
                                'check',
                                key,
                                device,
                                main.deviceTypes[0] ?? 'device',
                                '0.0.0',
                            ),
                        });
                        await aggregator.add(endpoint);
                        const verdict = conformance.validate([endpoint, ...parts]);
                        for (const [ep, violations] of verdict) {
                            for (const violation of violations) {
                                issues.push({
                                    level: 'error',
                                    path: ep === endpoint ? 'endpoints[0]' : `endpoints[${1 + parts.indexOf(ep)}]`,
                                    message: `${violation.deviceType}: ${violation.kind} ${violation.requirement} — ${violation.detail}`,
                                });
                            }
                        }
                        await endpoint.close();
                    } catch (error) {
                        const details = nestedErrors(error);
                        issues.push({
                            level: 'error',
                            path: 'endpoints',
                            message: details.length > 0 ? details.join('; ') : (error as Error).message,
                        });
                    }
                }
            }
            if (issues.length > 0) {
                devices.set(key, issues);
            }
        }
    } finally {
        await node.close();
    }
    const ok = [...devices.values()].every((issues) => issues.every((i) => i.level !== 'error'));
    return {devices, ok};
}

/** the check's result as lines for the command line */
export function formatCheck(result: CheckResult): string[] {
    const lines: string[] = [];
    for (const [key, issues] of result.devices) {
        for (const issue of issues) {
            lines.push(`${issue.level === 'error' ? 'ERROR' : 'warn '} ${key} ${issue.path}: ${issue.message}`);
        }
    }
    lines.push(result.ok ? 'ok' : 'not ok');
    return lines;
}
