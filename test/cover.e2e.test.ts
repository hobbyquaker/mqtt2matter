/* The cover family against a recorded zigbee2mqtt session of an IKEA roller blind (E1757), replayed on a
   real matter.js node with an in-process broker, five times faster than recorded (the timeouts scaled with
   it). zigbee2mqtt counts 0 = closed, Matter 0 = open. The blind reports no `moving`; after a command
   zigbee2mqtt first repeats the old position, then echoes the commanded target (twice), then the real travel
   follows about once a second. The later moves were started at the blind itself. The table holds what a
   controller sees after each step: the current and target position and the lift's movement status. */

import {mkdtemp, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {WindowCoveringServer} from '../src/families/index.ts';
import {z2m} from '../src/importers/index.ts';
import {createLogger} from '../src/log.ts';
import type {DeviceHandle} from '../src/matter/bridge.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {freeUdpPort, settled, waitFor} from './helpers/util.ts';

const fixtures = join(import.meta.dirname, 'fixtures', 'z2m');
const BLIND = 'z2m:0x00124b0000000004';
const TOPIC = 'zigbee2mqtt/blind';
/** the replay runs this many times faster than recorded */
const SPEED = 5;
/** the shortest pause between two replayed messages, so each one is handled before the next */
const MIN_STEP = 80;

const STOPPED = 0;
const OPENING = 1;
const CLOSING = 2;

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
let app: App;
const published: {topic: string; payload: string}[] = [];
const logLines: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Commands = Record<string, (request: Record<string, unknown>) => Promise<void>>;
const commands = (behavior: unknown): Commands => behavior as Commands;

function device(key: string): DeviceHandle {
    const handle = app.nodes.handle(key);
    if (handle === undefined) {
        throw new Error(`no device ${key}`);
    }
    return handle;
}

interface Snapshot {
    current: number | null;
    target: number | null;
    lift: number;
}

function snapshot(key: string): Snapshot {
    const wc = device(key).state.windowCovering!;
    return {
        current: wc.currentPositionLiftPercent100ths as number | null,
        target: wc.targetPositionLiftPercent100ths as number | null,
        lift: (wc.operationalStatus as {lift: number}).lift,
    };
}

async function goTo(key: string, percent100ths: number): Promise<void> {
    // the family's own write of the last report may still hold the state lock
    await sleep(50);
    await device(key).endpoint.act((agent) =>
        commands(agent.get(WindowCoveringServer)).goToLiftPercentage!({liftPercent100thsValue: percent100ths}),
    );
}

async function expectPublished(topic: string, payload: string): Promise<void> {
    await waitFor(
        () => published.some((p) => p.topic === topic && p.payload === payload),
        5000,
        `${topic} ${payload}; got ${JSON.stringify(published)}`,
    );
}

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-cover-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync(['zigbee2mqtt/+/set', 'manual/+/set']);
    observer.on('message', (topic, payload) => published.push({topic, payload: payload.toString()}));

    const discovery = z2m.discover({
        devices: z2m.parseBridgeDevices(readFileSync(join(fixtures, 'fyrtur.json'))),
        groups: [],
    });
    const {devices} = z2m.adopt({}, discovery, {keys: [BLIND]});
    const blind = devices[BLIND]!;
    // the generator's options, with the timeouts scaled to the replay speed
    expect(blind.endpoints[0]!.options).toEqual({cover: {echoFilter: true}});
    blind.endpoints[0]!.options = {cover: {echoFilter: true, reportTimeout: 30 / SPEED, reportGap: 3 / SPEED}};

    const position = (topic: string) => ({
        attribute: 'WindowCovering.currentPositionLiftPercent100ths',
        status: {topic, extract: 'position', scale: {from: [0, 100], to: [10000, 0]}},
    });
    const target = (topic: string) => ({
        attribute: 'WindowCovering.targetPositionLiftPercent100ths',
        command: {topic: `${topic}/set`, wrap: 'position', scale: {from: [0, 100], to: [10000, 0]}, round: 0},
    });
    const config = parseConfig({
        mqtt: {url: broker.url},
        storage,
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices: {
            ...devices,
            // the focused cases: the same kind of cover, short timeouts
            echo: {
                name: 'Echoing cover',
                endpoints: [
                    {
                        deviceTypes: ['WindowCovering'],
                        options: {cover: {echoFilter: true, reportTimeout: 2, reportGap: 0.4}},
                        mappings: [position('manual/echo'), target('manual/echo')],
                    },
                ],
            },
            plain: {
                name: 'Plain cover',
                endpoints: [
                    {
                        deviceTypes: ['WindowCovering'],
                        options: {cover: {reportTimeout: 2, reportGap: 0.4}},
                        mappings: [position('manual/plain'), target('manual/plain')],
                    },
                ],
            },
        },
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

/** ms since the command; `set` is the controller's command, `state` a report of the blind */
type Step = [at: number, kind: 'set' | 'state', position: number];

/* The recorded session, the times in ms after the command. */
const TRACE: Step[] = [
    [0, 'set', 40],
    [663, 'state', 0],
    [664, 'state', 40],
    [1686, 'state', 40],
    [1691, 'state', 2],
    [2697, 'state', 9],
    [3709, 'state', 12],
    [4729, 'state', 18],
    [5746, 'state', 24],
    [6762, 'state', 30],
    [7781, 'state', 36],
    [8808, 'state', 40],
    // moved down at the blind
    [28139, 'state', 38],
    [29161, 'state', 31],
    [30187, 'state', 28],
    [31196, 'state', 22],
    [32217, 'state', 16],
    [33234, 'state', 10],
    [34254, 'state', 4],
    [35273, 'state', 0],
    // moved up at the blind, stopped there
    [42393, 'state', 2],
    [43414, 'state', 5],
    [44432, 'state', 12],
    [45449, 'state', 18],
    [46475, 'state', 24],
    [47489, 'state', 30],
    // moved down at the blind
    [65820, 'state', 28],
    [66838, 'state', 22],
    [67850, 'state', 16],
    [68870, 'state', 12],
    [69885, 'state', 6],
    [70915, 'state', 0],
];

/** what a controller should see after each step (and, last, a moment after the final report) */
const EXPECTED: [step: string, current: number, target: number, lift: number][] = [
    ['set 40', 10000, 6000, OPENING],
    ['0 (the old position again)', 10000, 6000, OPENING],
    ['40 (the echoed target)', 10000, 6000, OPENING],
    ['40 (the echo once more)', 10000, 6000, OPENING],
    ['2', 9800, 6000, OPENING],
    ['9', 9100, 6000, OPENING],
    ['12', 8800, 6000, OPENING],
    ['18', 8200, 6000, OPENING],
    ['24', 7600, 6000, OPENING],
    ['30', 7000, 6000, OPENING],
    ['36', 6400, 6000, OPENING],
    ['40', 6000, 6000, STOPPED],
    ['38', 6200, 10000, CLOSING],
    ['31', 6900, 10000, CLOSING],
    ['28', 7200, 10000, CLOSING],
    ['22', 7800, 10000, CLOSING],
    ['16', 8400, 10000, CLOSING],
    ['10', 9000, 10000, CLOSING],
    ['4', 9600, 10000, CLOSING],
    ['0', 10000, 10000, STOPPED],
    ['2', 9800, 0, OPENING],
    ['5', 9500, 0, OPENING],
    ['12', 8800, 0, OPENING],
    ['18', 8200, 0, OPENING],
    ['24', 7600, 0, OPENING],
    // the reports stop: the movement ends there long before the next one starts
    ['30', 7000, 7000, STOPPED],
    ['28', 7200, 10000, CLOSING],
    ['22', 7800, 10000, CLOSING],
    ['16', 8400, 10000, CLOSING],
    ['12', 8800, 10000, CLOSING],
    ['6', 9400, 10000, CLOSING],
    ['0', 10000, 10000, STOPPED],
];

function stateMessage(position: number): string {
    return JSON.stringify({position, state: position === 0 ? 'CLOSE' : 'OPEN'});
}

describe('a roller blind without movement reports (recorded session)', () => {
    it('shows the commanded travel and the moves started at the blind as they happen', async () => {
        await observer.publishAsync(TOPIC, stateMessage(0));
        await settled(() => {
            expect(snapshot(BLIND)).toEqual({current: 10000, target: 10000, lift: STOPPED});
        });
        published.length = 0;

        // the schedule: the recorded times sped up, but never two messages closer than MIN_STEP
        const at: number[] = [];
        for (const [index, [time]] of TRACE.entries()) {
            at.push(Math.max(time / SPEED, index === 0 ? 0 : at[index - 1]! + MIN_STEP));
        }
        const start = Date.now();
        const seen: [string, number | null, number | null, number][] = [];
        for (const [index, [, kind, position]] of TRACE.entries()) {
            await sleep(start + at[index]! - Date.now());
            if (kind === 'set') {
                await goTo(BLIND, 10000 - position * 100);
                await expectPublished(`${TOPIC}/set`, JSON.stringify({position}));
            } else {
                // the recorded echo of the target still said CLOSE
                const echo = index === 2 || index === 3;
                await observer.publishAsync(
                    TOPIC,
                    echo ? JSON.stringify({position, state: 'CLOSE'}) : stateMessage(position),
                );
            }
            // the state just before the next message (or, after the last, a moment later)
            const next = index + 1 < TRACE.length ? at[index + 1]! - 10 : at[index]! + MIN_STEP;
            await sleep(start + next - Date.now());
            const {current, target, lift} = snapshot(BLIND);
            seen.push([EXPECTED[index]![0], current, target, lift]);
        }
        expect(seen).toEqual(EXPECTED);
        expect(logLines.filter((l) => l.includes('ERROR'))).toEqual([]);
    }, 60_000);
});

describe('the echo filter', () => {
    it('holds back the echoed target until the travel reports; applies it when nothing else comes', async () => {
        await observer.publishAsync('manual/echo', JSON.stringify({position: 0}));
        await settled(() => {
            expect(snapshot('echo')).toEqual({current: 10000, target: 10000, lift: STOPPED});
        });
        // a command, the echo of its target, then the travel
        await goTo('echo', 5000);
        await observer.publishAsync('manual/echo', JSON.stringify({position: 50}));
        await sleep(150);
        expect(snapshot('echo')).toEqual({current: 10000, target: 5000, lift: OPENING});
        await observer.publishAsync('manual/echo', JSON.stringify({position: 10}));
        await settled(() => {
            expect(snapshot('echo')).toEqual({current: 9000, target: 5000, lift: OPENING});
        });
        await observer.publishAsync('manual/echo', JSON.stringify({position: 50}));
        await settled(() => {
            expect(snapshot('echo')).toEqual({current: 5000, target: 5000, lift: STOPPED});
        });

        // a cover that reports only where it ended: the held report is applied after the report gap
        await goTo('echo', 0);
        await observer.publishAsync('manual/echo', JSON.stringify({position: 100}));
        await sleep(150);
        expect(snapshot('echo')).toEqual({current: 5000, target: 0, lift: OPENING});
        await settled(() => {
            expect(snapshot('echo')).toEqual({current: 0, target: 0, lift: STOPPED});
        }, 2000);
    });

    it('is off by default: a report at the target ends the movement at once', async () => {
        await observer.publishAsync('manual/plain', JSON.stringify({position: 0}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 10000, target: 10000, lift: STOPPED});
        });
        await goTo('plain', 5000);
        await observer.publishAsync('manual/plain', JSON.stringify({position: 50}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 5000, target: 5000, lift: STOPPED});
        });
    });
});

describe('movements started at the cover', () => {
    it('show the direction of the reports and end a report gap after the last one', async () => {
        await observer.publishAsync('manual/plain', JSON.stringify({position: 50}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 5000, target: 5000, lift: STOPPED});
        });
        await observer.publishAsync('manual/plain', JSON.stringify({position: 55}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4500, target: 0, lift: OPENING});
        });
        await observer.publishAsync('manual/plain', JSON.stringify({position: 60}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4000, target: 0, lift: OPENING});
        });
        // reversed at the cover
        await observer.publishAsync('manual/plain', JSON.stringify({position: 52}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4800, target: 10000, lift: CLOSING});
        });
        // the reports stop: ended after the gap (0.4 s), well before the report timeout (2 s)
        const stopped = Date.now();
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4800, target: 4800, lift: STOPPED});
        }, 1500);
        expect(Date.now() - stopped).toBeLessThan(1500);
    });
});

describe('a commanded movement', () => {
    it('waits the report timeout for the first report, then ends a report gap after the last one', async () => {
        await observer.publishAsync('manual/plain', JSON.stringify({position: 50}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 5000, target: 5000, lift: STOPPED});
        });
        await goTo('plain', 0);
        // longer than the gap: no report yet, the cover may still be starting
        await sleep(800);
        expect(snapshot('plain')).toEqual({current: 5000, target: 0, lift: OPENING});
        await observer.publishAsync('manual/plain', JSON.stringify({position: 60}));
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4000, target: 0, lift: OPENING});
        });
        // stopped at the cover before the target: ends after the gap, at the last report
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4000, target: 4000, lift: STOPPED});
        }, 1500);
    });

    it('ends after the report timeout when no report comes at all', async () => {
        await goTo('plain', 10000);
        await sleep(800);
        expect(snapshot('plain')).toEqual({current: 4000, target: 10000, lift: CLOSING});
        await settled(() => {
            expect(snapshot('plain')).toEqual({current: 4000, target: 4000, lift: STOPPED});
        }, 3000);
    });
});
