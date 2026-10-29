/* Identity on the Matter side. matter.js persists endpoint numbers per endpoint id path, so the ids
   here are what keeps a device's endpoint number stable across restarts: the device key is the id of
   the bridged node, `<key>~<endpoint id>` a child's. The unique id controllers use to recognise a device
   is a hash of the bridge id and the device key; it never changes while the key does not. Renaming a
   device changes `name`, never the key. */

import {createHash} from 'node:crypto';

/** the characters matter.js accepts in an endpoint id (not `.`, its path separator); anything else becomes `_` */
export function sanitizeId(text: string): string {
    return text.replace(/[^A-Za-z0-9:_-]/g, '_');
}

export function deviceEndpointId(deviceKey: string): string {
    return sanitizeId(deviceKey);
}

export function childEndpointId(deviceKey: string, endpointId: string): string {
    return `${sanitizeId(deviceKey)}~${sanitizeId(endpointId)}`;
}

/** BridgedDeviceBasicInformation.uniqueId: 32 characters, stable per (bridge, device) */
export function uniqueId(bridgeId: string, deviceKey: string): string {
    return createHash('sha256').update(`${bridgeId}|${deviceKey}`).digest('hex').slice(0, 32);
}

/** Matter's 32-character strings (labels, product names, serial numbers) */
export function label32(text: string | undefined, fallback: string): string {
    const value = (text ?? '').trim() || fallback;
    return value.length > 32 ? value.slice(0, 32) : value;
}

/** a random passcode outside the values the specification forbids */
export function randomPasscode(): number {
    const forbidden = new Set([
        0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
    ]);
    for (;;) {
        const candidate = 1 + Math.floor(Math.random() * 99999998);
        if (!forbidden.has(candidate)) {
            return candidate;
        }
    }
}

export function randomDiscriminator(): number {
    return Math.floor(Math.random() * 4096);
}

/**
 * BasicInformation.softwareVersion (uint32) from the package's semver: major·1 000 000 + minor·1 000 + patch.
 * It grows with every release, which is what controllers and OTA compare; a pre-release counts as its release.
 */
export function softwareVersionNumber(version: string): number {
    const [major = 0, minor = 0, patch = 0] = (version.split('-')[0] ?? '')
        .split('.')
        .map((part) => Math.min(Number.parseInt(part, 10) || 0, 999));
    return Math.min(major, 4293) * 1_000_000 + minor * 1_000 + patch;
}

/** the product's own hardware: mqtt2matter is software, its "hardware" is version 1 */
export const HARDWARE_VERSION = 1;

/** the vendor name of the bridge node itself */
export const VENDOR_NAME = 'mqtt2matter';
/** the bridge's productLabel: Matter says it should not include the vendor name */
export const BRIDGE_PRODUCT_LABEL = 'MQTT to Matter bridge';

/** a productLabel without the vendor name (Matter: "should not include" it); the fallback when nothing is left */
export function productLabel(text: string | undefined, vendorName: string, fallback: string): string {
    const label = label32(text, fallback);
    if (vendorName === '' || !label.includes(vendorName)) {
        return label;
    }
    const stripped = label.split(vendorName).join(' ').replace(/\s+/g, ' ').trim();
    return stripped === '' || stripped.includes(vendorName) ? fallback.slice(0, 32) : stripped;
}

/** BridgedDeviceBasicInformation of a bridged device */
export function bridgedInformation(
    bridgeId: string,
    key: string,
    device: {name: string; vendor?: string | undefined; model?: string | undefined; serial?: string | undefined},
    primaryType: string,
    softwareVersion: string,
): Record<string, unknown> {
    const vendorName = label32(device.vendor, VENDOR_NAME);
    return {
        nodeLabel: label32(device.name, key),
        vendorName,
        productName: label32(device.model, primaryType),
        productLabel: productLabel(device.model, vendorName, primaryType),
        serialNumber: label32(device.serial, key),
        uniqueId: uniqueId(bridgeId, key),
        softwareVersion: softwareVersionNumber(softwareVersion),
        softwareVersionString: softwareVersion.slice(0, 64),
        hardwareVersion: HARDWARE_VERSION,
        hardwareVersionString: String(HARDWARE_VERSION),
        reachable: true,
    };
}
