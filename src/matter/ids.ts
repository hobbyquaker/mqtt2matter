/* Identity on the Matter side. matter.js persists endpoint numbers per endpoint id path, so the ids
   here are what keeps a device's endpoint number stable across restarts: the device key is the id of
   the bridged node, `<key>~<endpoint id>` a child's. The unique id controllers use to recognise a device
   is a hash of the bridge id and the device key; it never changes while the key does not. Renaming a
   device changes `name`, never the key. */

import {createHash} from 'node:crypto';

/** the characters matter.js accepts in an endpoint id; anything else becomes `_` */
export function sanitizeId(text: string): string {
    return text.replace(/[^A-Za-z0-9:._-]/g, '_');
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
