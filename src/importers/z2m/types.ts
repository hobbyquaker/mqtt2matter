/* The shapes zigbee2mqtt publishes on `<base>/bridge/devices` and `<base>/bridge/groups`, as far as the
   importer reads them (zigbee2mqtt 1.x and 2.x; see its docs under "MQTT topics and messages"). Unknown
   fields are carried through untouched. */

/** an expose, or a feature of a specific expose (`light`, `switch`, `cover`, `lock`, `climate`, `fan`) */
export interface Expose {
    /** `binary`, `numeric`, `enum`, `text`, `composite`, `list`, or a specific type with `features` */
    type: string;
    name?: string;
    label?: string;
    /** the key in the state payload, with the endpoint suffix (`state_l1`) */
    property?: string;
    /** bit 1 = published in the state, 2 = settable (`/set`), 4 = gettable (`/get`) */
    access?: number;
    /** the zigbee2mqtt endpoint name (`l1`, `left`, …) of a multi-endpoint device */
    endpoint?: string;
    unit?: string;
    value_min?: number;
    value_max?: number;
    value_step?: number;
    value_on?: unknown;
    value_off?: unknown;
    values?: (string | number)[];
    features?: Expose[];
    description?: string;
    /** zigbee2mqtt 2.x: `config` and `diagnostic` exposes are settings and metrics, not the device's function */
    category?: string;
}

export interface BridgeDeviceDefinition {
    vendor?: string;
    model?: string;
    description?: string;
    exposes?: Expose[];
    options?: Expose[];
    supports_ota?: boolean;
}

export interface BridgeDevice {
    ieee_address: string;
    friendly_name: string;
    /** `Coordinator`, `Router`, `EndDevice`, `GreenPower`, `Unknown` */
    type: string;
    supported?: boolean;
    disabled?: boolean;
    interview_completed?: boolean;
    interviewing?: boolean;
    /** `Battery`, `Mains (single phase)`, `DC Source`, … */
    power_source?: string;
    model_id?: string;
    manufacturer?: string;
    definition?: BridgeDeviceDefinition | null;
    [key: string]: unknown;
}

export interface BridgeGroupMember {
    ieee_address: string;
    endpoint: number;
}

export interface BridgeGroup {
    id: number;
    friendly_name: string;
    members: BridgeGroupMember[];
    scenes?: {id: number; name: string}[];
    [key: string]: unknown;
}

export const ACCESS_STATE = 1;
export const ACCESS_SET = 2;
export const ACCESS_GET = 4;

export function canRead(expose: Expose): boolean {
    return ((expose.access ?? ACCESS_STATE) & ACCESS_STATE) !== 0;
}

export function canSet(expose: Expose): boolean {
    return ((expose.access ?? 0) & ACCESS_SET) !== 0;
}

export function canGet(expose: Expose): boolean {
    return ((expose.access ?? 0) & ACCESS_GET) !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** parse a `bridge/devices` payload; throws on anything that is not a list of devices with addresses */
export function parseBridgeDevices(payload: string | Buffer): BridgeDevice[] {
    const parsed: unknown = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    if (!Array.isArray(parsed)) {
        throw new Error('bridge/devices is not an array');
    }
    return parsed.map((entry: unknown, i) => {
        if (!isRecord(entry) || typeof entry.ieee_address !== 'string' || typeof entry.friendly_name !== 'string') {
            throw new Error(`bridge/devices[${i}] has no ieee_address / friendly_name`);
        }
        return entry as unknown as BridgeDevice;
    });
}

/** parse a `bridge/groups` payload */
export function parseBridgeGroups(payload: string | Buffer): BridgeGroup[] {
    const parsed: unknown = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    if (!Array.isArray(parsed)) {
        throw new Error('bridge/groups is not an array');
    }
    return parsed.map((entry: unknown, i) => {
        if (!isRecord(entry) || typeof entry.id !== 'number' || typeof entry.friendly_name !== 'string') {
            throw new Error(`bridge/groups[${i}] has no id / friendly_name`);
        }
        const members = Array.isArray(entry.members) ? (entry.members as BridgeGroupMember[]) : [];
        return {...entry, members} as BridgeGroup;
    });
}
