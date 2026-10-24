/* The first device end to end: an in-process broker, the application with one OnOffPlugInUnit bound to a
   status/command topic pair, a real matter.js ServerNode. A retained status sets the attribute; a
   controller's command (the node's own interaction API, `endpoint.act`) publishes the command payload and,
   without optimistic, leaves the attribute to the device's report; a restart keeps the endpoint number. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt, {type MqttClient} from 'mqtt';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {App} from '../src/app.ts';
import {parseConfig} from '../src/config/load.ts';
import {OnOffServer} from '../src/families/on-off.ts';
import {startBroker, type Broker} from './helpers/broker.ts';
import {freeUdpPort, waitFor} from './helpers/util.ts';

let broker: Broker;
let storage: string;
let port: number;
let observer: MqttClient;
const received: {topic: string; payload: string}[] = [];

beforeAll(async () => {
    broker = await startBroker();
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-e2e-'));
    port = await freeUdpPort();
    observer = await mqtt.connectAsync(broker.url);
    await observer.subscribeAsync('cmnd/#');
    observer.on('message', (topic, payload) => received.push({topic, payload: payload.toString()}));
});

afterAll(async () => {
    await observer.endAsync();
    await broker.close();
    await rm(storage, {recursive: true, force: true});
});

function config(): ReturnType<typeof parseConfig> {
    return parseConfig({
        mqtt: {url: broker.url},
        storage,
        log: {matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices: {
            'plug-1': {
                name: 'Test plug',
                vendor: 'Acme',
                model: 'Plug 1',
                endpoints: [
                    {
                        deviceTypes: ['OnOffPlugInUnit'],
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'stat/plug1/POWER', map: {ON: true, OFF: false}},
                                command: {topic: 'cmnd/plug1/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                        ],
                    },
                ],
            },
            'plug-2': {
                name: 'Optimistic plug',
                endpoints: [
                    {
                        deviceTypes: ['OnOffPlugInUnit'],
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                command: {topic: 'cmnd/plug2/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                        ],
                    },
                ],
            },
        },
    });
}

describe('one plug end to end', () => {
    let app: App;
    let numberOfPlug1: number | undefined;

    it('starts a bridge with pairing codes and the device as a bridged endpoint', async () => {
        // the device's retained state is on the broker before the bridge starts
        await observer.publishAsync('stat/plug1/POWER', 'ON', {retain: true});
        app = new App(config(), {mqttConnectTimeout: 5000});
        await app.start();

        const [bridge] = app.nodes.info();
        expect(bridge).toBeDefined();
        expect(bridge!.online).toBe(true);
        expect(bridge!.commissioned).toBe(false);
        expect(bridge!.pairingCodes?.manualPairingCode).toMatch(/^\d{11}$/);
        expect(bridge!.pairingCodes?.qrPairingCode).toMatch(/^MT:/);
        expect(bridge!.devices.map((d) => d.key).sort()).toEqual(['plug-1', 'plug-2']);

        const plug = app.nodes.handle('plug-1')!;
        expect(plug.endpoint.id).toBe('plug-1');
        numberOfPlug1 = plug.number;
        expect(numberOfPlug1).toBeGreaterThan(1);
        expect(plug.state.bridgedDeviceBasicInformation!.nodeLabel).toBe('Test plug');
        expect(plug.state.bridgedDeviceBasicInformation!.vendorName).toBe('Acme');
        expect(plug.state.bridgedDeviceBasicInformation!.serialNumber).toBe('plug-1');
        expect(plug.state.bridgedDeviceBasicInformation!.uniqueId).toHaveLength(32);
        expect(plug.state.bridgedDeviceBasicInformation!.reachable).toBe(true);
    });

    it('applies the retained status and later status messages', async () => {
        const plug = app.nodes.handle('plug-1')!;
        await waitFor(() => plug.state.onOff!.onOff === true, 5000, 'retained ON');
        await observer.publishAsync('stat/plug1/POWER', 'OFF');
        await waitFor(() => plug.state.onOff!.onOff === false, 5000, 'OFF');
        await observer.publishAsync('stat/plug1/POWER', 'TOGGLE');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(plug.state.onOff!.onOff).toBe(false);
    });

    it("publishes a controller's command and waits for the device's report", async () => {
        const plug = app.nodes.handle('plug-1')!;
        received.length = 0;
        await plug.endpoint.act((agent) => agent.get(OnOffServer).on());
        await waitFor(() => received.length === 1, 5000, 'command');
        expect(received[0]).toEqual({topic: 'cmnd/plug1/POWER', payload: 'ON'});
        // not optimistic: the attribute follows the device's status, not the command
        expect(plug.state.onOff!.onOff).toBe(false);
        await observer.publishAsync('stat/plug1/POWER', 'ON');
        await waitFor(() => plug.state.onOff!.onOff === true, 5000, 'ON after the report');

        await plug.endpoint.act((agent) => agent.get(OnOffServer).toggle());
        await waitFor(() => received.length === 2, 5000, 'toggle command');
        expect(received[1]).toEqual({topic: 'cmnd/plug1/POWER', payload: 'OFF'});
        expect(plug.state.onOff!.onOff).toBe(true);
    });

    it('applies a command locally when the mapping has no status half', async () => {
        const plug = app.nodes.handle('plug-2')!;
        received.length = 0;
        expect(plug.state.onOff!.onOff).toBe(false);
        await plug.endpoint.act((agent) => agent.get(OnOffServer).on());
        await waitFor(() => received.length === 1, 5000, 'command');
        expect(received[0]).toEqual({topic: 'cmnd/plug2/POWER', payload: 'ON'});
        expect(plug.state.onOff!.onOff).toBe(true);
    });

    it('keeps the endpoint number across a restart and writes the shard map', async () => {
        await app.stop();
        app = new App(config(), {mqttConnectTimeout: 5000});
        await app.start();
        const plug = app.nodes.handle('plug-1')!;
        expect(plug.number).toBe(numberOfPlug1);
        const shards = JSON.parse(
            await (await import('node:fs/promises')).readFile(join(storage, 'shards.json'), 'utf8'),
        );
        expect(shards).toEqual({'plug-1': 'default', 'plug-2': 'default'});
        await app.stop();
    });
});
