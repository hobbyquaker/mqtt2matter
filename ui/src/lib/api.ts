/* The API client: docs/api.md as typed functions. Every call goes through `request`, which turns the
   server's `{error, details}` into an ApiError the pages show as a notice. */

export class ApiError extends Error {
    readonly status: number;
    readonly details: unknown;

    constructor(status: number, message: string, details?: unknown) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.details = details;
    }

    /** the validator's issues when the server sent some */
    get issues(): Issue[] {
        const details = this.details as {issues?: Issue[]} | undefined;
        return Array.isArray(details?.issues) ? details.issues : [];
    }
}

export interface Issue {
    level: 'error' | 'warning';
    path: string;
    message: string;
}

export type Scalar = boolean | number | string;

export interface StatusHalf {
    topic: string;
    extract?: string;
    template?: string;
    type?: 'boolean' | 'number' | 'string';
    map?: Record<string, Scalar>;
    default?: Scalar;
    unit?: string;
    scale?: {from: [number, number]; to: [number, number]; clamp?: boolean};
    offset?: number;
    invert?: boolean;
    round?: number;
    expire?: number;
    get?: {topic: string; payload?: string};
    codec?: {module: string; options?: unknown};
}

export interface CommandHalf {
    topic: string;
    unit?: string;
    scale?: {from: [number, number]; to: [number, number]; clamp?: boolean};
    offset?: number;
    invert?: boolean;
    round?: number;
    precision?: number;
    format?: Record<string, string>;
    payload?: string;
    template?: string;
    wrap?: string;
    retain?: boolean;
    qos?: 0 | 1 | 2;
    optimistic?: boolean;
    codec?: {module: string; options?: unknown};
}

export interface Binding {
    attribute?: string;
    invoke?: string;
    event?: string;
    status?: StatusHalf;
    command?: CommandHalf;
    comment?: string;
}

export interface Endpoint {
    id: string;
    deviceTypes: string[];
    features?: Record<string, string[]>;
    attributes?: Record<string, Record<string, unknown>>;
    bindings: Binding[];
    options: Record<string, Record<string, unknown>>;
    coalesce: number;
}

export interface AvailabilityTopic {
    topic: string;
    extract?: string;
    template?: string;
    online: string;
    offline: string;
}

export interface Source {
    kind: 'manual' | 'z2m' | 'ha-discovery' | 'preset';
    key?: string;
    version?: string;
    raw?: unknown;
    orphaned?: boolean;
}

export interface Device {
    name: string;
    vendor?: string;
    model?: string;
    serial?: string;
    enabled: boolean;
    bridge?: string;
    source: Source;
    availability?: {topics: AvailabilityTopic[]; mode: 'all' | 'any' | 'latest'};
    endpoints: Endpoint[];
}

export interface DeviceListEntry {
    key: string;
    name: string;
    enabled: boolean;
    deviceTypes: string[];
    endpoints: number;
    source: Source;
    bridge: string | undefined;
    number: number | undefined;
    reachable: boolean | undefined;
    built: boolean;
    violations: number;
    errors: number;
    warnings: number;
}

export type EndpointState = Record<
    string,
    {number: number | undefined; state: Record<string, Record<string, unknown>>}
>;

export interface DeviceDetail {
    key: string;
    device: Device;
    issues: Issue[];
    built: boolean;
    bridge: string | undefined;
    number: number | undefined;
    state?: EndpointState;
}

export interface BridgeInfo {
    id: string;
    port: number;
    online: boolean;
    commissioned: boolean;
    pairingCodes: {manualPairingCode: string; qrPairingCode: string} | undefined;
    devices: number;
    fabrics: {index: number; label: string; vendorId: number; nodeId: string; fabricId: string}[];
    windowStatus: number;
}

export interface Status {
    version: string;
    uptime: number;
    running: boolean;
    configPath: string;
    mqtt: {url: string; connected: boolean};
    bridges: BridgeInfo[];
    devices: number;
    importers: string[];
}

export interface Catalog {
    deviceTypes: {
        name: string;
        id: number;
        classification: string;
        clusters: {cluster: string; mandatory: boolean; features: string[]}[];
    }[];
    clusters: string[];
    composites: Record<string, {cluster: string; fields: string[]; features: string[]; description: string}>;
    units: string[];
    eventChannels: string[];
}

export interface ClusterInfo {
    name: string;
    id: number;
    features: {code: string; title: string}[];
    attributes: {
        name: string;
        id: number;
        metatype: string;
        nullable: boolean;
        writable: boolean;
        enumMembers?: Record<string, number>;
        bitFields?: {name: string; bit: number}[];
        min?: number;
        max?: number;
        conformance: string;
    }[];
    commands: {name: string; id: number; fields: string[]}[];
    events: string[];
}

export interface Stage {
    step: string;
    ok: boolean;
    value?: unknown;
    reason?: string;
}

export interface Preview {
    stages: Stage[];
    ok: boolean;
    result?: unknown;
    reason?: string;
}

export interface TopicEntry {
    topic: string;
    payload: string;
    retain: boolean;
    ts: number;
}

export interface PresetEntry {
    id: string;
    name: string;
    description?: string;
    vendor?: string;
    variables: Record<string, {label: string; description?: string; default?: string; optional: boolean}>;
    shipped: boolean;
    file: string;
}

export interface Conflict {
    path: string;
    user: unknown;
    before: unknown;
    now: unknown;
    applied: boolean;
}

/** the importer's report entry (docs/importers.md), tagged with the importer */
export interface AdoptEntry {
    importer: string;
    key: string;
    kind: 'device' | 'group';
    name: string;
    status: 'new' | 'unchanged' | 'updated' | 'orphaned' | 'restored' | 'invalid' | 'unsupported';
    conflicts: Conflict[];
    edits: number;
    unmapped: string[];
    notes: string[];
    /** the area the source suggests (Home Assistant's suggested_area) */
    area?: string;
    /** another importer describes the same device natively (its key): native preferred */
    native?: string;
}

export interface LogEntry {
    id: number;
    ts: string;
    level: string;
    scope: string;
    message: string;
}

export interface ConfigView {
    path: string;
    settings: Record<string, unknown>;
    overridden: string[];
    effective: Record<string, unknown>;
}

export interface CheckResult {
    ok: boolean;
    devices: Record<string, Issue[]>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method,
            ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
        });
    } catch (error) {
        throw new ApiError(0, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    const json: unknown = text === '' ? undefined : JSON.parse(text);
    if (!response.ok) {
        const error = json as {error?: string; details?: unknown} | undefined;
        throw new ApiError(
            response.status,
            error?.error ?? `${response.status} ${response.statusText}`,
            error?.details,
        );
    }
    return json as T;
}

export const api = {
    status: () => request<Status>('GET', '/api/status'),
    config: () => request<ConfigView>('GET', '/api/config'),
    saveConfig: (settings: unknown) =>
        request<{saved: boolean; restartNeeded: boolean}>('PUT', '/api/config', settings),
    devices: () => request<DeviceListEntry[]>('GET', '/api/devices'),
    device: (key: string) => request<DeviceDetail>('GET', `/api/devices/${encodeURIComponent(key)}`),
    saveDevice: (key: string, device: unknown) =>
        request<DeviceDetail>('PUT', `/api/devices/${encodeURIComponent(key)}`, device),
    deleteDevice: (key: string) => request<void>('DELETE', `/api/devices/${encodeURIComponent(key)}`),
    deviceState: (key: string) => request<EndpointState>('GET', `/api/devices/${encodeURIComponent(key)}/state`),
    validate: (device: unknown) => request<{ok: boolean; issues: Issue[]}>('POST', '/api/validate', {device}),
    check: (devices?: Record<string, unknown>) =>
        request<CheckResult>('POST', '/api/check', devices === undefined ? {} : {devices}),
    previewStatus: (half: unknown, payload: string, attribute?: string, topic?: string) =>
        request<Preview>('POST', '/api/preview', {direction: 'status', half, payload, attribute, topic}),
    previewCommand: (half: unknown, value: unknown, attribute?: string, fields?: Record<string, unknown>) =>
        request<Preview>('POST', '/api/preview', {direction: 'command', half, value, attribute, fields}),
    publish: (topic: string, payload: string, retain = false, qos: 0 | 1 | 2 = 0) =>
        request<{published: boolean}>('POST', '/api/publish', {topic, payload, retain, qos}),
    topics: (prefix = '') => request<TopicEntry[]>('GET', `/api/topics?prefix=${encodeURIComponent(prefix)}`),
    catalog: () => request<Catalog>('GET', '/api/catalog'),
    cluster: (name: string) => request<ClusterInfo>('GET', `/api/catalog/clusters/${encodeURIComponent(name)}`),
    presets: () =>
        request<{presets: PresetEntry[]; problems: {file: string; message: string}[]}>('GET', '/api/presets'),
    applyPreset: (id: string, values: Record<string, string>) =>
        request<{device: Device; issues: Issue[]}>('POST', `/api/presets/${encodeURIComponent(id)}/apply`, {values}),
    bridges: () => request<BridgeInfo[]>('GET', '/api/bridges'),
    commissioning: (id: string, open: boolean, minutes?: number) =>
        request<BridgeInfo>('POST', `/api/bridges/${encodeURIComponent(id)}/commissioning`, {open, minutes}),
    removeFabric: (id: string, index: number) =>
        request<void>('DELETE', `/api/bridges/${encodeURIComponent(id)}/fabrics/${index}`),
    adopt: () => request<{importers: string[]; entries: AdoptEntry[]}>('GET', '/api/adopt'),
    resync: () => request<{importers: string[]; entries: AdoptEntry[]; written: string[]}>('POST', '/api/adopt/resync'),
    adoptDevice: (kind: string, key: string) =>
        request<DeviceDetail & {entry: AdoptEntry}>(
            'POST',
            `/api/adopt/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
            {},
        ),
    exportAll: () => request<Record<string, unknown>>('GET', '/api/export'),
    exportDevice: (key: string) =>
        request<Record<string, unknown>>('GET', `/api/export?device=${encodeURIComponent(key)}`),
    importDevices: (devices: Record<string, unknown>, replace: boolean) =>
        request<{imported: number}>('POST', '/api/import', {devices, replace}),
    log: (limit = 500, after = 0) => request<LogEntry[]>('GET', `/api/log?limit=${limit}&after=${after}`),
};

export function errorMessage(error: unknown): string {
    if (error instanceof ApiError) {
        const issues = error.issues;
        return issues.length > 0
            ? `${error.message}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
            : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
