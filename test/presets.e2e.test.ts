/* Every shipped preset against a real matter.js node and an in-process broker: applied with its fixture values
   (test/fixtures/presets), the device's documented status messages must set the attributes, a controller's
   commands must publish the documented messages, availability must drive reachable. One App, every preset. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {
    ColorControlServer,
    LevelControlServer,
    OnOffServer,
    RvcOperationalStateServer,
    RvcRunModeServer,
    WindowCoveringServer,
} from '../src/families/index.ts';
import {createLogger} from '../src/log.ts';
import type {DeviceHandle} from '../src/matter/bridge.ts';
import {applyPreset} from '../src/model/presets.ts';
import {loadPresets} from '../src/server/presets.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {type CommandCase, type Payload, deviceKeyOf, payloadText, presetCases} from './helpers/preset-fixtures.ts';
import {freeUdpPort, settled, waitFor} from './helpers/util.ts';

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
let app: App;
const published: {topic: string; payload: string}[] = [];
const logLines: string[] = [];
const cases = presetCases();

type Commands = Record<string, (request: Record<string, unknown>) => Promise<void>>;
const commands = (behavior: unknown): Commands => behavior as Commands;
type Handle = Pick<DeviceHandle, 'endpoint' | 'state'>;

function endpointOf(key: string, id = 'main'): Handle {
    const handle = app.nodes.handle(key);
    if (handle === undefined) {
        throw new Error(`no device ${key}`);
    }
    if (id === 'main') {
        return handle;
    }
    const child = handle.endpoints.get(id);
    if (child === undefined) {
        throw new Error(`no endpoint ${id} on ${key}`);
    }
    return child;
}

/**
 * what a controller does; the args are the command's numbers. A state the runtime is writing from a status report
 * at that moment cannot be locked synchronously by `act`; a controller's interaction would wait, so this retries.
 */
async function act(handle: Handle, command: CommandCase): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await actOnce(handle, command);
            return;
        } catch (error) {
            if (attempt >= 20 || !String(error).includes('synchronously')) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

async function actOnce(handle: Handle, command: CommandCase): Promise<void> {
    const args = command.args ?? {};
    const level = {optionsMask: {}, optionsOverride: {}, transitionTime: 0};
    await handle.endpoint.act(async (agent) => {
        switch (command.action) {
            case 'on':
                return agent.get(OnOffServer).on();
            case 'off':
                return agent.get(OnOffServer).off();
            case 'level':
                return commands(agent.get(LevelControlServer)).moveToLevelWithOnOff!({...level, level: args.level});
            case 'mireds':
                return commands(agent.get(ColorControlServer)).moveToColorTemperature!({
                    ...level,
                    colorTemperatureMireds: args.mireds,
                });
            case 'hs':
                return commands(agent.get(ColorControlServer)).moveToHueAndSaturation!({
                    ...level,
                    hue: args.hue,
                    saturation: args.saturation,
                });
            case 'lift':
                return commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({
                    liftPercent100thsValue: args.percent100ths,
                });
            case 'open':
                return agent.get(WindowCoveringServer).upOrOpen();
            case 'close':
                return agent.get(WindowCoveringServer).downOrClose();
            case 'stop':
                return agent.get(WindowCoveringServer).stopMotion();
            case 'runMode':
                await agent.get(RvcRunModeServer).changeToMode({newMode: args.mode!});
                return;
            case 'pause':
                await agent.get(RvcOperationalStateServer).pause();
                return;
            case 'resume':
                await agent.get(RvcOperationalStateServer).resume();
                return;
            case 'goHome':
                await agent.get(RvcOperationalStateServer).goHome();
                return;
            default:
                throw new Error(`unknown action ${command.action}`);
        }
    });
}

function samePayload(expected: Payload, actual: string): boolean {
    if (typeof expected === 'string') {
        return expected === actual;
    }
    try {
        expect(JSON.parse(actual)).toEqual(expected);
        return true;
    } catch {
        return false;
    }
}

const recorders = new Map<Handle, string[]>();

/** the switch events of an endpoint from now on (one recorder per endpoint, emptied on every call) */
function record(handle: Handle): string[] {
    const known = recorders.get(handle);
    if (known !== undefined) {
        known.length = 0;
        return known;
    }
    const seen: string[] = [];
    recorders.set(handle, seen);
    const events = handle.endpoint.events as unknown as Record<
        string,
        Record<string, {on(fn: (payload: unknown) => void): void}>
    >;
    for (const name of [
        'initialPress',
        'shortRelease',
        'longPress',
        'longRelease',
        'multiPressOngoing',
        'multiPressComplete',
        'switchLatched',
    ]) {
        events.switch![name]?.on(() => seen.push(name));
    }
    return seen;
}

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-presets-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync('#');
    observer.on('message', (topic, payload) => published.push({topic, payload: payload.toString()}));
    const library = await loadPresets([]);
    const devices: Record<string, unknown> = {};
    for (const {preset} of library.presets) {
        const presetCase = cases.get(preset.id);
        if (presetCase !== undefined) {
            devices[deviceKeyOf(preset.id)] = applyPreset(preset, presetCase.values);
        }
    }
    const config = parseConfig({
        mqtt: {url: broker.url},
        storage,
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices,
    });
    app = new App(config, {mqttConnectTimeout: 5000, log: createLogger('warn', (line) => logLines.push(line))});
    await app.start();
}, 60_000);

afterAll(async () => {
    await app.stop();
    await observer.endAsync();
    await broker.close();
    await rm(storage, {recursive: true, force: true});
}, 60_000);

describe('the shipped presets on a bridge', () => {
    it('build without conformance violations', () => {
        const info = app.nodes.info()[0]!;
        expect(info.devices.map((d) => d.key).sort()).toEqual([...cases.keys()].map(deviceKeyOf).sort());
        expect(info.devices.filter((d) => d.violations > 0)).toEqual([]);
        expect(logLines.filter((l) => l.includes('ERROR') || l.includes('WARN'))).toEqual([]);
    });

    for (const [id, presetCase] of cases) {
        const key = deviceKeyOf(id);
        describe(id, () => {
            if (presetCase.availability !== undefined) {
                it('availability', async () => {
                    for (const message of presetCase.availability!) {
                        await observer.publishAsync(message.topic, payloadText(message.payload));
                        await waitFor(
                            () => endpointOf(key).state.bridgedDeviceBasicInformation!.reachable === message.reachable,
                            5000,
                            `${message.topic} ${payloadText(message.payload)} → reachable ${message.reachable}`,
                        );
                    }
                });
            }
            if (presetCase.status !== undefined) {
                it('status', async () => {
                    const logged = logLines.length;
                    for (const message of presetCase.status!) {
                        const handle = endpointOf(key, message.endpoint);
                        const seen = message.events === undefined ? [] : record(handle);
                        await observer.publishAsync(message.topic, payloadText(message.payload));
                        await settled(() => {
                            const state = handle.state;
                            for (const [path, value] of Object.entries(message.expect ?? {})) {
                                const [behavior, attribute] = path.split('.') as [string, string];
                                const actual = state[behavior]?.[attribute];
                                const what = `${payloadText(message.payload)} → ${path}`;
                                if (value !== null && typeof value === 'object') {
                                    expect(actual, what).toMatchObject(value);
                                } else {
                                    expect(actual, what).toEqual(value);
                                }
                            }
                            if (message.events !== undefined) {
                                expect(seen).toEqual(message.events);
                            }
                        });
                    }
                    expect(logLines.slice(logged).filter((l) => l.includes('WARN') || l.includes('ERROR'))).toEqual([]);
                });
            }
            if (presetCase.commands !== undefined) {
                it('commands', async () => {
                    for (const command of presetCase.commands!) {
                        published.length = 0;
                        await act(endpointOf(key, command.endpoint), command);
                        for (const expected of command.publishes) {
                            await waitFor(
                                () =>
                                    published.some(
                                        (p) => p.topic === expected.topic && samePayload(expected.payload, p.payload),
                                    ),
                                5000,
                                `${command.action} → ${expected.topic} ${payloadText(expected.payload)}; got ${JSON.stringify(published)}`,
                            );
                        }
                    }
                });
            }
        });
    }
});
