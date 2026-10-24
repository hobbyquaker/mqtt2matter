/* Migrations of the device format. A file written by an earlier version is brought to the current
   schema on load, so it keeps working; the next save writes the current form. Each step is idempotent
   and changes only what it recognises. */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** migrate one raw device entry in place; true when something changed */
export function migrateDevice(device: unknown): boolean {
    if (!isRecord(device) || !Array.isArray(device.endpoints)) {
        return false;
    }
    let changed = false;
    for (const endpoint of device.endpoints) {
        // the joins of a Matter element with MQTT were called bindings before they were called mappings
        if (!isRecord(endpoint) || !('bindings' in endpoint)) {
            continue;
        }
        const old = endpoint.bindings;
        delete endpoint.bindings;
        if (endpoint.mappings === undefined) {
            endpoint.mappings = old;
        } else if (Array.isArray(endpoint.mappings) && Array.isArray(old)) {
            endpoint.mappings = [...(endpoint.mappings as unknown[]), ...(old as unknown[])];
        }
        changed = true;
    }
    return changed;
}

/** migrate a raw `devices` object in place; the keys of the devices that changed */
export function migrateDevices(devices: unknown): string[] {
    if (!isRecord(devices)) {
        return [];
    }
    return Object.entries(devices)
        .filter(([, device]) => migrateDevice(device))
        .map(([key]) => key);
}
