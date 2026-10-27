/* The web server: the REST API and the event stream of docs/api.md over node:http, and the built UI as
   static files. It is the only thing the UI talks to. Everything it does goes through the application
   (devices, the MQTT connection, the bridges), the config store (the file) and the catalogue; it owns
   no state of its own beyond the connected event clients. */

import {createServer, type Server as HttpServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';

import {Minutes, type ServerNode} from '@matter/main';
import {DeviceCommissioner, FabricManager} from '@matter/main/protocol';

import type {App} from '../app.ts';
import type {Logger} from '../log.ts';
import type {DeviceHandle} from '../matter/bridge.ts';
import {checkConfig} from '../matter/check.ts';
import {migrateDevices} from '../model/migrate.ts';
import {applyPreset} from '../model/presets.ts';
import {DeviceSchema, type DeviceConfig, type DevicesInput} from '../model/schema.ts';
import {type Issue, validateDevice} from '../model/validate.ts';
import {catalogJson, clusterJson} from './catalog.ts';
import {compactDevice} from './compact.ts';
import type {ConfigStore} from './config-store.ts';
import {EventHub} from './events.ts';
import {type FabricJson, type SessionSource, fabricJson} from './fabrics.ts';
import {AuthConfigSchema} from '../config/schema.ts';
import {Auth, hashPassword} from './auth.ts';
import {HttpError, type Request, Router, sendJson, serveStatic} from './http.ts';
import {Updater} from './update.ts';
import type {Importer, SyncEntry} from './importers.ts';
import type {LogBuffer} from './log-buffer.ts';
import {loadPresets} from './presets.ts';
import {type RuntimeFigures, RuntimeStats} from './stats.ts';
import {previewCommand, previewStatus} from './preview.ts';

export interface ServerOptions {
    app: App;
    store: ConfigStore;
    log: Logger;
    logBuffer: LogBuffer;
    version: string;
    host?: string;
    /** 0 for an ephemeral port */
    port?: number;
    /** the built UI; default: the package's `ui/dist` */
    uiDir?: string;
    importers?: readonly Importer[];
    /** who may use the API and the event stream; default: everyone */
    auth?: Auth;
    /** restart and update from the UI; default: neither (no supervisor) */
    updater?: Updater;
    /** a clean stop with the restart exit code (main.ts); called after the answer went out */
    onRestart?: () => void;
    /** the MQTT subscriptions for the topic tree */
    topics?: readonly string[];
}

export interface DeviceListEntry {
    key: string;
    name: string;
    enabled: boolean;
    deviceTypes: string[];
    endpoints: number;
    source: DeviceConfig['source'];
    bridge: string | undefined;
    number: number | undefined;
    reachable: boolean | undefined;
    built: boolean;
    violations: number;
    errors: number;
    warnings: number;
}

export interface BridgeJson {
    id: string;
    port: number;
    online: boolean;
    commissioned: boolean;
    pairingCodes: {manualPairingCode: string; qrPairingCode: string} | undefined;
    devices: number;
    fabrics: FabricJson[];
    /** 0 closed, 1 enhanced, 2 basic (the AdministratorCommissioning window status) */
    windowStatus: number;
}

export interface StatsJson extends RuntimeFigures {
    devices: number;
    endpoints: number;
    bridges: number;
    bridgesCommissioned: number;
    /** the controllers paired, over all bridges */
    fabrics: number;
    mqttConnected: boolean;
    /** the topics in the cache (everything the bridge subscribed to and saw) */
    mqttTopics: number;
}

/** the package's `ui/dist`, from `src/server/` or `dist/server/` alike */
export const UI_DIST = resolve(new URL('../../ui/dist', import.meta.url).pathname);

/** attributes every cluster has and no one wants in the event stream */
const GLOBAL_ATTRIBUTES = new Set([
    'attributeList',
    'acceptedCommandList',
    'generatedCommandList',
    'eventList',
    'featureMap',
    'clusterRevision',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** what answers without a login: the login itself, and what the UI needs to show it */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/auth', '/api/auth/login', '/api/auth/logout']);

function body(request: Request): Record<string, unknown> {
    return isRecord(request.body) ? request.body : {};
}

export class Server {
    readonly options: ServerOptions;
    private readonly app: App;
    private readonly store: ConfigStore;
    private readonly log: Logger;
    private readonly hub: EventHub;
    private readonly router = new Router();
    private readonly http: HttpServer;
    private readonly observers = new Map<string, (() => void)[]>();
    private readonly unsubscribe: (() => void)[] = [];
    private readonly startedAt = Date.now();
    private readonly auth: Auth;
    private readonly updater: Updater;
    private readonly stats = new RuntimeStats();

    constructor(options: ServerOptions) {
        this.options = options;
        this.app = options.app;
        this.store = options.store;
        this.log = options.log;
        this.auth = options.auth ?? Auth.open();
        this.updater = options.updater ?? new Updater({current: options.version});
        this.hub = new EventHub(options.log.child('events'), () => ({type: 'hello', version: options.version}));
        this.http = createServer((request, response) => {
            const path = new URL(request.url ?? '/', 'http://localhost').pathname;
            if (path.startsWith('/api/')) {
                if (!PUBLIC_PATHS.has(path) && !this.auth.check(request)) {
                    sendJson(response, 401, {error: 'authentication required'});
                    return;
                }
                this.router.dispatch(request, response).then(
                    (matched) => {
                        if (!matched) {
                            sendJson(response, 404, {error: `no route ${path}`});
                        }
                    },
                    (error: unknown) => {
                        this.log.error(`${request.method ?? ''} ${path} failed`, error);
                        if (!response.headersSent) {
                            sendJson(response, 500, {error: 'internal error'});
                        }
                    },
                );
                return;
            }
            serveStatic(options.uiDir ?? UI_DIST, path, response).catch((error: unknown) => {
                this.log.error(`serving ${path} failed`, error);
            });
        });
        this.http.on('upgrade', (request, socket, head) => {
            const path = new URL(request.url ?? '/', 'http://localhost').pathname;
            if (path === '/api/events' && !this.auth.check(request)) {
                socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            } else if (path === '/api/events') {
                this.hub.upgrade(request, socket, head);
            } else {
                socket.destroy();
            }
        });
        this.routes();
        this.stats.start();
    }

    /** the bound port */
    get port(): number {
        const address = this.http.address() as AddressInfo | null;
        return address?.port ?? 0;
    }

    async listen(): Promise<void> {
        const host = this.options.host ?? '0.0.0.0';
        await new Promise<void>((resolveListen, reject) => {
            this.http.once('error', reject);
            this.http.listen(this.options.port ?? 0, host, () => {
                this.http.off('error', reject);
                resolveListen();
            });
        });
        this.log.info(`listening on http://${host}:${this.port}`);
    }

    /** wire the running application: the topic subscriptions, the events of the built devices */
    async start(): Promise<void> {
        for (const topic of this.options.topics ?? []) {
            try {
                await this.app.mqtt.subscribe(topic);
            } catch (error) {
                this.log.warn(`subscribing ${topic} for the UI failed: ${String(error)}`);
            }
        }
        for (const importer of this.importers()) {
            for (const topic of importer.topics) {
                try {
                    await this.app.mqtt.subscribe(topic);
                } catch (error) {
                    this.log.warn(`subscribing ${topic} for ${importer.kind} failed: ${String(error)}`);
                }
            }
            importer.load(this.app.mqtt.cache);
        }
        const onMessage = (topic: string, payload: Buffer, retain: boolean): void => {
            this.stats.count();
            this.hub.broadcast({
                type: 'mqtt',
                topic,
                payload: payload.toString('utf8').slice(0, 16_384),
                retain,
                ts: Date.now(),
            });
            for (const importer of this.importers()) {
                if (importer.handle(topic, payload)) {
                    this.hub.broadcast({type: 'discovered'});
                }
            }
        };
        this.app.mqtt.on('message', onMessage);
        this.unsubscribe.push(() => {
            this.app.mqtt.off('message', onMessage);
        });
        const onConnect = (): void => {
            this.hub.broadcast({type: 'status', mqtt: true});
        };
        const onClose = (): void => {
            this.hub.broadcast({type: 'status', mqtt: false});
        };
        this.app.mqtt.on('connect', onConnect);
        this.app.mqtt.on('close', onClose);
        this.unsubscribe.push(() => {
            this.app.mqtt.off('connect', onConnect);
            this.app.mqtt.off('close', onClose);
        });
        this.unsubscribe.push(
            this.options.logBuffer.onEntry((entry) => {
                this.hub.broadcast({type: 'log', entry});
            }),
        );
        for (const [key, handle] of this.app.nodes.handles()) {
            this.observe(key, handle);
        }
        for (const bridge of this.app.nodes.allBridges()) {
            const node = bridge.serverNode;
            if (node === undefined) {
                continue;
            }
            const notify = (): void => {
                this.hub.broadcast({type: 'bridges'});
            };
            node.events.commissioning.commissioned.on(notify);
            node.events.commissioning.decommissioned.on(notify);
            node.events.commissioning.fabricsChanged.on(notify);
            this.unsubscribe.push(() => {
                node.events.commissioning.commissioned.off(notify);
                node.events.commissioning.decommissioned.off(notify);
                node.events.commissioning.fabricsChanged.off(notify);
            });
        }
    }

    async close(): Promise<void> {
        this.stats.stop();
        for (const off of this.unsubscribe.splice(0)) {
            off();
        }
        for (const key of [...this.observers.keys()]) {
            this.unobserve(key);
        }
        this.hub.close();
        await new Promise<void>((resolveClose) => {
            this.http.close(() => {
                resolveClose();
            });
            this.http.closeAllConnections();
        });
    }

    /** every attribute change of a device's endpoints goes to the event stream */
    private observe(key: string, handle: DeviceHandle): void {
        this.unobserve(key);
        const offs: (() => void)[] = [];
        for (const [endpointId, endpoint] of handle.endpoints) {
            const clusters = new Map(
                [...endpoint.built.clusters].map(([cluster, behaviorId]) => [behaviorId, cluster]),
            );
            const events = endpoint.endpoint.events as Record<string, Record<string, unknown> | undefined>;
            for (const [behaviorId, attributes] of Object.entries(endpoint.state)) {
                const cluster = clusters.get(behaviorId) ?? behaviorId;
                for (const attribute of Object.keys(attributes)) {
                    if (GLOBAL_ATTRIBUTES.has(attribute)) {
                        continue;
                    }
                    const observable = events[behaviorId]?.[`${attribute}$Changed`] as
                        {on(fn: (value: unknown) => void): void; off(fn: unknown): void} | undefined;
                    if (observable === undefined || typeof observable.on !== 'function') {
                        continue;
                    }
                    const listener = (value: unknown): void => {
                        this.hub.broadcast({type: 'attribute', key, endpoint: endpointId, cluster, attribute, value});
                    };
                    observable.on(listener);
                    offs.push(() => {
                        observable.off(listener);
                    });
                }
            }
        }
        this.observers.set(key, offs);
    }

    private unobserve(key: string): void {
        for (const off of this.observers.get(key) ?? []) {
            off();
        }
        this.observers.delete(key);
    }

    // ── the device list and one device ────────────────────────────────────────────────────────────

    private placement(): Map<string, {bridge: string; number: number | undefined; violations: number}> {
        const map = new Map<string, {bridge: string; number: number | undefined; violations: number}>();
        for (const info of this.app.nodes.info()) {
            for (const device of info.devices) {
                map.set(device.key, {bridge: info.id, number: device.number, violations: device.violations});
            }
        }
        return map;
    }

    private listDevices(): DeviceListEntry[] {
        const placement = this.placement();
        const handles = this.app.nodes.handles();
        return Object.entries(this.app.config.devices).map(([key, device]) => {
            const placed = placement.get(key);
            const handle = handles.get(key);
            const result = validateDevice(device);
            const reachable = handle?.state.bridgedDeviceBasicInformation?.reachable;
            return {
                key,
                name: device.name,
                enabled: device.enabled,
                deviceTypes: device.endpoints[0]?.deviceTypes ?? [],
                endpoints: device.endpoints.length,
                source: device.source,
                bridge: placed?.bridge ?? device.bridge,
                number: placed?.number,
                reachable: typeof reachable === 'boolean' ? reachable : undefined,
                built: handle !== undefined,
                violations: placed?.violations ?? 0,
                errors: result.errors.length,
                warnings: result.warnings.length,
            };
        });
    }

    private deviceJson(key: string): unknown {
        const device = this.app.config.devices[key];
        if (device === undefined) {
            throw new HttpError(404, `no device ${key}`);
        }
        const handle = this.app.nodes.handle(key);
        const issues: Issue[] = [...validateDevice(device).issues];
        for (const {endpointId, violation} of handle?.violations() ?? []) {
            issues.push({
                level: 'warning',
                path: `endpoints[${device.endpoints.findIndex((e) => e.id === endpointId)}]`,
                message: `${violation.deviceType}: ${violation.kind} ${violation.requirement} — ${violation.detail}`,
            });
        }
        return {
            key,
            device,
            issues,
            built: handle !== undefined,
            bridge: this.placement().get(key)?.bridge ?? device.bridge,
            number: handle?.number,
            state: handle === undefined ? undefined : this.stateJson(handle),
        };
    }

    private stateJson(handle: DeviceHandle): Record<string, {number: number | undefined; state: unknown}> {
        const out: Record<string, {number: number | undefined; state: unknown}> = {};
        for (const [id, endpoint] of handle.endpoints) {
            const state: Record<string, Record<string, unknown>> = {};
            const clusters = new Map(
                [...endpoint.built.clusters].map(([cluster, behaviorId]) => [behaviorId, cluster]),
            );
            for (const [behaviorId, attributes] of Object.entries(endpoint.state)) {
                const cluster = clusters.get(behaviorId);
                if (cluster === undefined) {
                    continue;
                }
                state[cluster] = Object.fromEntries(
                    Object.entries(attributes).filter(([name]) => !GLOBAL_ATTRIBUTES.has(name)),
                );
            }
            out[id] = {number: endpoint.number, state};
        }
        return out;
    }

    /** save a device (compact in the file, parsed in the app), build it, tell the clients */
    private async saveDevice(key: string, raw: unknown): Promise<unknown> {
        const parsed = DeviceSchema.safeParse(raw);
        if (!parsed.success) {
            throw new HttpError(400, 'the device is invalid', {
                issues: parsed.error.issues.map((issue) => ({
                    level: 'error',
                    path: issue.path.map(String).join('.'),
                    message: issue.message,
                })),
            });
        }
        const device = parsed.data;
        await this.store.saveDevice(key, compactDevice(device));
        const handle = await this.app.applyDevice(key, device);
        this.unobserve(key);
        if (handle !== undefined) {
            this.observe(key, handle);
        }
        this.hub.broadcast({type: 'devices'});
        return this.deviceJson(key);
    }

    private async removeDevice(key: string): Promise<void> {
        if (this.app.config.devices[key] === undefined) {
            throw new HttpError(404, `no device ${key}`);
        }
        this.unobserve(key);
        await this.store.deleteDevice(key);
        await this.app.removeDevice(key);
        this.hub.broadcast({type: 'devices'});
    }

    // ── bridges ────────────────────────────────────────────────────────────────────────────────────

    /** the statistics popup: the process figures and what the bridge holds; cheap, no Matter round trip */
    private statsJson(): StatsJson {
        const devices = Object.values(this.app.config.devices);
        const bridges = this.app.nodes.allBridges();
        let fabrics = 0;
        for (const bridge of bridges) {
            const node = bridge.serverNode;
            if (node !== undefined) {
                try {
                    fabrics += node.env.get(FabricManager).length;
                } catch {
                    // the node is not up yet
                }
            }
        }
        return {
            ...this.stats.figures(),
            devices: devices.length,
            endpoints: devices.reduce((sum, device) => sum + device.endpoints.length, 0),
            bridges: bridges.length,
            bridgesCommissioned: bridges.filter((bridge) => bridge.info().commissioned).length,
            fabrics,
            mqttConnected: this.app.mqtt.connected,
            mqttTopics: this.app.mqtt.cache.size,
        };
    }

    /** the sessions matter.js holds on a bridge node; none while the node is not up */
    private sessionsOf(node: ServerNode): SessionSource[] {
        try {
            return Object.values(node.state.sessions.sessions).map((session) => ({
                fabric: session.fabric === undefined ? undefined : {fabricIndex: Number(session.fabric.fabricIndex)},
                isPeerActive: session.isPeerActive,
                lastInteractionTimestamp: session.lastInteractionTimestamp,
                numberOfActiveSubscriptions: session.numberOfActiveSubscriptions,
            }));
        } catch {
            return [];
        }
    }

    private bridgesJson(): BridgeJson[] {
        return this.app.nodes.allBridges().map((bridge) => {
            const node = bridge.serverNode;
            let fabrics: FabricJson[] = [];
            if (node !== undefined) {
                const sessions = this.sessionsOf(node);
                fabrics = node.env.get(FabricManager).map((f) =>
                    fabricJson(
                        {
                            fabricIndex: Number(f.fabricIndex),
                            fabricId: f.fabricId,
                            nodeId: f.nodeId,
                            rootNodeId: f.rootNodeId,
                            rootVendorId: f.rootVendorId,
                            globalId: f.globalId,
                            label: f.label,
                        },
                        sessions,
                    ),
                );
            }
            let windowStatus = 0;
            if (node !== undefined) {
                try {
                    windowStatus = node.env.get(DeviceCommissioner).windowStatus;
                } catch {
                    windowStatus = 0;
                }
            }
            const info = bridge.info();
            return {
                id: info.id,
                port: info.port,
                online: info.online,
                commissioned: info.commissioned,
                pairingCodes: info.pairingCodes,
                devices: info.devices.length,
                fabrics,
                windowStatus,
            };
        });
    }

    private bridgeNode(id: string) {
        const bridge = this.app.nodes.bridge(id);
        if (bridge === undefined) {
            throw new HttpError(404, `no bridge ${id}`);
        }
        const node = bridge.serverNode;
        if (node === undefined) {
            throw new HttpError(409, `bridge ${id} is not running`);
        }
        return node;
    }

    // ── adopt ──────────────────────────────────────────────────────────────────────────────────────

    private importers(): readonly Importer[] {
        return this.options.importers ?? [];
    }

    private importer(kind: string): Importer {
        const importer = this.importers().find((i) => i.kind === kind);
        if (importer === undefined) {
            throw new HttpError(404, `no importer ${kind}`);
        }
        return importer;
    }

    /** the importers' reports over the file's devices, each entry tagged with its importer */
    private adoptReport(): (SyncEntry & {importer: string})[] {
        const devices = this.store.rawDevices as DevicesInput;
        return this.importers().flatMap((importer) =>
            importer.diff(devices).map((entry) => ({...entry, importer: importer.kind})),
        );
    }

    /** write the devices an adoption changed into the file and the bridge; returns the keys written */
    private async applyAdoption(
        before: DevicesInput,
        after: DevicesInput,
        only?: ReadonlySet<string>,
    ): Promise<string[]> {
        const written: string[] = [];
        for (const [key, device] of Object.entries(after)) {
            if (only !== undefined && !only.has(key)) {
                continue;
            }
            if (JSON.stringify(before[key]) === JSON.stringify(device)) {
                continue;
            }
            await this.saveDevice(key, device);
            written.push(key);
        }
        return written;
    }

    // ── authentication ─────────────────────────────────────────────────────────────────────────────

    private authRoutes(): void {
        const r = this.router;
        r.add('GET', '/api/auth', (request) => this.auth.state(request.raw));
        r.add('POST', '/api/auth/login', async (request, response) => {
            if (this.auth.mode !== 'password') {
                throw new HttpError(400, `there is no password login in ${this.auth.mode} mode`);
            }
            const address = request.raw.socket.remoteAddress ?? '';
            if (this.auth.throttled(address)) {
                throw new HttpError(429, 'too many failed logins; try again in a few minutes');
            }
            const password = body(request).password;
            const token = typeof password === 'string' ? await this.auth.login(password, address) : undefined;
            if (token === undefined) {
                this.log.warn(`failed login from ${address}`);
                throw new HttpError(401, 'wrong password');
            }
            response.setHeader('set-cookie', this.auth.cookie(request.raw, token));
            return {mode: this.auth.mode, authenticated: true};
        });
        r.add('POST', '/api/auth/logout', (request, response) => {
            this.auth.logout(request.raw);
            response.setHeader('set-cookie', this.auth.cookie(request.raw, undefined));
            return {mode: this.auth.mode, authenticated: this.auth.mode !== 'password' && this.auth.check(request.raw)};
        });
        // the access settings, applied at once and written to the file (behind the login like every other route)
        r.add('PUT', '/api/auth', async (request, response) => {
            const b = body(request);
            const mode = b.mode;
            if (mode !== 'none' && mode !== 'password' && mode !== 'proxy') {
                throw new HttpError(400, 'mode is none, password or proxy');
            }
            const settings = this.store.rawSettings();
            const server = isRecord(settings.server) ? {...settings.server} : {};
            const current = isRecord(server.auth) ? server.auth : {};
            const raw: Record<string, unknown> = {mode};
            for (const key of ['proxyHeader', 'proxyLogoutUrl', 'sessionHours'] as const) {
                const value = b[key] === undefined ? current[key] : b[key];
                if (value !== undefined && value !== '' && value !== null) {
                    raw[key] = value;
                }
            }
            let hash = this.auth.passwordHash;
            if (typeof b.password === 'string' && b.password !== '') {
                hash = await hashPassword(b.password);
            }
            if (mode === 'password') {
                if (hash === undefined) {
                    throw new HttpError(400, 'password mode needs a password');
                }
                raw.password = hash;
            }
            const parsed = AuthConfigSchema.safeParse(raw);
            if (!parsed.success) {
                throw new HttpError(400, `the access settings are invalid: ${parsed.error.issues[0]?.message ?? ''}`);
            }
            // the request that switches to proxy mode must already come through the proxy
            const header = parsed.data.proxyHeader;
            if (mode === 'proxy' && request.raw.headers[header.toLowerCase()] === undefined) {
                throw new HttpError(
                    409,
                    `this request does not carry ${header}: in proxy mode the UI would lock you out`,
                );
            }
            server.auth = raw;
            settings.server = server;
            await this.store.saveSettings(settings);
            this.auth.reconfigure(parsed.data, mode === 'password' ? hash : undefined);
            this.log.info(`access: ${mode}`);
            if (mode === 'password') {
                // whoever set the password stays logged in
                response.setHeader('set-cookie', this.auth.cookie(request.raw, this.auth.newSession()));
            }
            return {mode, authenticated: true};
        });
    }

    // ── the routes ─────────────────────────────────────────────────────────────────────────────────

    private routes(): void {
        const r = this.router;

        r.add('GET', '/api/status', () => ({
            version: this.options.version,
            uptime: Math.round((Date.now() - this.startedAt) / 1000),
            running: this.app.running,
            configPath: this.store.path,
            mqtt: {url: this.app.config.mqtt.url, connected: this.app.mqtt.connected},
            bridges: this.bridgesJson(),
            devices: Object.keys(this.app.config.devices).length,
            importers: this.importers().map((i) => i.kind),
            update: this.updater.known,
        }));

        r.add('GET', '/api/stats', () => this.statsJson());

        r.add('GET', '/api/update', async (request) => {
            await this.updater.check(request.query.get('check') === '1');
            return await this.updater.status();
        });
        r.add('POST', '/api/update', async (request) => {
            const version = body(request).version;
            const reason = await this.updater.request(typeof version === 'string' ? version : '');
            if (reason !== undefined) {
                throw new HttpError(409, reason);
            }
            this.log.info(`update to ${String(version)} requested`);
            return {requested: version};
        });
        r.add('POST', '/api/restart', () => {
            const reason = this.updater.restartReason;
            if (reason !== undefined) {
                throw new HttpError(409, reason);
            }
            this.log.info('restart requested from the UI');
            setTimeout(() => this.options.onRestart?.(), 300).unref();
            return {restarting: true};
        });

        r.add('GET', '/api/config', () => ({
            path: this.store.path,
            settings: this.store.rawSettings(),
            overridden: this.store.overridden,
            effective: {
                mqtt: {
                    ...this.app.config.mqtt,
                    password: this.app.config.mqtt.password === undefined ? undefined : '***',
                },
                storage: this.app.config.storage,
                log: this.app.config.log,
                vendorId: this.app.config.vendorId,
                productId: this.app.config.productId,
                bridges: this.app.config.bridges,
                server: {
                    ...this.app.config.server,
                    auth: this.auth.view(),
                },
                presets: this.app.config.presets,
                importers: this.app.config.importers,
            },
        }));
        r.add('PUT', '/api/config', async (request) => {
            await this.store.saveSettings(request.body);
            return {saved: true, restartNeeded: true};
        });

        this.authRoutes();

        r.add('GET', '/api/devices', () => this.listDevices());
        r.add('GET', '/api/devices/:key', (request) => this.deviceJson(request.params.key ?? ''));
        r.add('PUT', '/api/devices/:key', async (request) => {
            return await this.saveDevice(request.params.key ?? '', request.body);
        });
        r.add('DELETE', '/api/devices/:key', async (request) => {
            await this.removeDevice(request.params.key ?? '');
        });
        r.add('GET', '/api/devices/:key/state', (request) => {
            const key = request.params.key ?? '';
            const handle = this.app.nodes.handle(key);
            if (handle === undefined) {
                throw new HttpError(404, `device ${key} is not built`);
            }
            return this.stateJson(handle);
        });

        r.add('POST', '/api/validate', (request) => {
            const parsed = DeviceSchema.safeParse(body(request).device);
            if (!parsed.success) {
                return {
                    ok: false,
                    issues: parsed.error.issues.map((issue) => ({
                        level: 'error',
                        path: issue.path.map(String).join('.'),
                        message: issue.message,
                    })),
                };
            }
            const result = validateDevice(parsed.data);
            return {ok: result.ok, issues: result.issues};
        });

        r.add('POST', '/api/check', async (request) => {
            const wanted = body(request).devices;
            let devices = this.app.config.devices;
            if (isRecord(wanted)) {
                devices = {};
                for (const [key, raw] of Object.entries(wanted)) {
                    const parsed = DeviceSchema.safeParse(raw);
                    if (!parsed.success) {
                        throw new HttpError(400, `device ${key} is invalid`, {issues: parsed.error.issues});
                    }
                    devices[key] = parsed.data;
                }
            }
            const result = await checkConfig({...this.app.config, devices});
            return {ok: result.ok, devices: Object.fromEntries(result.devices)};
        });

        r.add('POST', '/api/preview', (request) => {
            const b = body(request);
            const attribute = typeof b.attribute === 'string' ? b.attribute : undefined;
            if (b.direction === 'status') {
                const payload = typeof b.payload === 'string' ? b.payload : JSON.stringify(b.payload ?? '');
                return previewStatus(b.half, payload, attribute, typeof b.topic === 'string' ? b.topic : undefined);
            }
            if (b.direction === 'command') {
                return previewCommand(b.half, b.value, attribute, isRecord(b.fields) ? b.fields : {});
            }
            throw new HttpError(400, 'direction is "status" or "command"');
        });

        r.add('POST', '/api/publish', async (request) => {
            const b = body(request);
            if (typeof b.topic !== 'string' || b.topic === '') {
                throw new HttpError(400, 'topic is required');
            }
            const payload = typeof b.payload === 'string' ? b.payload : JSON.stringify(b.payload ?? '');
            const qos = b.qos === 1 || b.qos === 2 ? b.qos : 0;
            await this.app.mqtt.publish(b.topic, payload, {retain: b.retain === true, qos});
            return {published: true};
        });

        r.add('GET', '/api/topics', (request) => {
            const prefix = request.query.get('prefix') ?? '';
            return this.app.mqtt.cache
                .topics()
                .filter((topic) => topic.startsWith(prefix))
                .sort()
                .map((topic) => {
                    const message = this.app.mqtt.cache.get(topic);
                    return {
                        topic,
                        payload: message?.payload.toString('utf8').slice(0, 16_384) ?? '',
                        retain: message?.retain ?? false,
                        ts: message?.ts ?? 0,
                    };
                });
        });

        r.add('GET', '/api/catalog', () => catalogJson());
        r.add('GET', '/api/catalog/clusters/:name', (request) => clusterJson(request.params.name ?? ''));

        r.add('GET', '/api/presets', async () => {
            const library = await loadPresets(this.app.config.presets);
            return {
                presets: library.presets.map(({preset, file, shipped}) => ({
                    id: preset.id,
                    name: preset.name,
                    description: preset.description,
                    vendor: preset.vendor,
                    variables: preset.variables,
                    shipped,
                    file,
                })),
                problems: library.problems,
            };
        });
        r.add('POST', '/api/presets/:id/apply', async (request) => {
            const id = request.params.id ?? '';
            const library = await loadPresets(this.app.config.presets);
            const entry = library.presets.find((p) => p.preset.id === id);
            if (entry === undefined) {
                throw new HttpError(404, `no preset ${id}`);
            }
            const values = body(request).values;
            try {
                const device = applyPreset(
                    entry.preset,
                    isRecord(values) ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) : {},
                );
                return {device, issues: validateDevice(device).issues};
            } catch (error) {
                throw new HttpError(400, (error as Error).message);
            }
        });

        r.add('GET', '/api/bridges', () => this.bridgesJson());
        r.add('POST', '/api/bridges/:id/commissioning', async (request) => {
            const node = this.bridgeNode(request.params.id ?? '');
            const commissioner = node.env.get(DeviceCommissioner);
            const b = body(request);
            if (b.open === false) {
                await commissioner.endCommissioning();
            } else {
                const minutes = typeof b.minutes === 'number' && b.minutes > 0 ? Math.min(b.minutes, 15) : 15;
                await commissioner.allowBasicCommissioning({timeout: Minutes(minutes)});
            }
            this.hub.broadcast({type: 'bridges'});
            return this.bridgesJson().find((bridge) => bridge.id === request.params.id);
        });
        r.add('DELETE', '/api/bridges/:id/fabrics/:index', async (request) => {
            const node = this.bridgeNode(request.params.id ?? '');
            const index = Number(request.params.index);
            const fabric = node.env.get(FabricManager).find((f) => Number(f.fabricIndex) === index);
            if (fabric === undefined) {
                throw new HttpError(404, `no fabric ${index}`);
            }
            await fabric.delete();
            this.hub.broadcast({type: 'bridges'});
        });

        r.add('GET', '/api/adopt', () => ({
            importers: this.importers().map((i) => i.kind),
            entries: this.adoptReport(),
        }));
        r.add('POST', '/api/adopt/resync', async () => {
            const written: string[] = [];
            for (const importer of this.importers()) {
                const before = structuredClone(this.store.rawDevices) as DevicesInput;
                const {devices} = importer.adopt(before, {keys: [], resync: true, orphan: true});
                written.push(...(await this.applyAdoption(before, devices)));
            }
            return {importers: this.importers().map((i) => i.kind), entries: this.adoptReport(), written};
        });
        r.add('POST', '/api/adopt/:kind/:key', async (request) => {
            const importer = this.importer(request.params.kind ?? '');
            const key = request.params.key ?? '';
            const b = body(request);
            const force = b.force === true;
            const replace = force && b.replace === true;
            const before = structuredClone(this.store.rawDevices) as DevicesInput;
            const {devices, report} = importer.adopt(before, {
                keys: [key],
                resync: true,
                orphan: false,
                force,
                replace,
            });
            const entry = report.find((e) => e.key === key);
            if (entry === undefined) {
                throw new HttpError(404, `${importer.kind} does not know ${key}`);
            }
            if (entry.status === 'unsupported' || entry.status === 'invalid') {
                throw new HttpError(409, `${key} cannot be adopted: ${entry.notes.join('; ')}`);
            }
            if (entry.status === 'covered' && !force) {
                throw new HttpError(
                    409,
                    `${key} is the same device as ${entry.covered ?? '?'}: adopting it makes a second Matter device ` +
                        '(force: true adopts it anyway, replace: true also disables the twin)',
                    {covered: entry.covered, twins: entry.twins ?? []},
                );
            }
            await this.applyAdoption(before, devices, new Set([key, ...(replace ? (entry.twins ?? []) : [])]));
            return {...(this.deviceJson(key) as object), entry};
        });

        r.add('GET', '/api/export', (request, response) => {
            const key = request.query.get('device');
            if (key !== null) {
                const raw = this.store.rawDevice(key);
                if (raw === undefined) {
                    throw new HttpError(404, `no device ${key}`);
                }
                response.setHeader('content-disposition', `attachment; filename="${key}.json"`);
                return {[key]: raw};
            }
            response.setHeader('content-disposition', 'attachment; filename="mqtt2matter.json"');
            return this.store.raw;
        });
        r.add('POST', '/api/import', async (request) => {
            const b = body(request);
            const devices = isRecord(b.devices)
                ? b.devices
                : isRecord(b.config)
                  ? (b.config as {devices?: unknown}).devices
                  : undefined;
            if (!isRecord(devices)) {
                throw new HttpError(400, 'expected {devices: {...}} or {config: {devices: {...}}}');
            }
            // an export of an earlier version imports as it is
            migrateDevices(devices);
            const parsed = new Map<string, DeviceConfig>();
            for (const [key, raw] of Object.entries(devices)) {
                const result = DeviceSchema.safeParse(raw);
                if (!result.success) {
                    throw new HttpError(400, `device ${key} is invalid`, {
                        issues: result.error.issues.map((issue) => ({
                            level: 'error',
                            path: `${key}.${issue.path.map(String).join('.')}`,
                            message: issue.message,
                        })),
                    });
                }
                parsed.set(key, result.data);
            }
            if (b.replace === true) {
                for (const key of Object.keys(this.app.config.devices)) {
                    if (!parsed.has(key)) {
                        this.unobserve(key);
                        await this.app.removeDevice(key);
                    }
                }
            }
            let written = 0;
            for (const [key, device] of parsed) {
                await this.saveDevice(key, device);
                written++;
            }
            if (b.replace === true) {
                await this.store.replaceDevices(
                    Object.fromEntries([...parsed].map(([key, device]) => [key, compactDevice(device)])),
                );
            }
            this.hub.broadcast({type: 'devices'});
            return {imported: written};
        });

        r.add('GET', '/api/log', (request) => {
            const limit = Number(request.query.get('limit') ?? 500);
            const after = Number(request.query.get('after') ?? 0);
            return this.options.logBuffer.list(
                Number.isFinite(limit) ? limit : 500,
                Number.isFinite(after) ? after : 0,
            );
        });
    }
}
