/* The stack the browser tests and a developer's look at the UI run against: an in-process broker on
   an ephemeral port, the application with a small configuration in a temporary directory, a real
   matter.js node on a free UDP port, the web server on an ephemeral port — and zigbee2mqtt's bridge
   topics from the test corpus, so the adopt page has something to show. Prints `PORT <n>` once it
   listens; stops on SIGTERM/SIGINT (and when stdin closes, with UI_SERVE_STDIN=1). Node ≥ 22.18 runs it
   directly: `node ui/test/serve.ts`, then open the port it prints. */

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import mqtt from 'mqtt';

import {App} from '../../src/app.ts';
import {parseConfig} from '../../src/config/load.ts';
import {createLogger} from '../../src/log.ts';
import {ConfigStore} from '../../src/server/config-store.ts';
import {HaImporter, Z2mImporter} from '../../src/server/importers.ts';
import {LogBuffer} from '../../src/server/log-buffer.ts';
import {Server} from '../../src/server/server.ts';
import {Updater} from '../../src/server/update.ts';
import {startBroker} from '../../test/helpers/broker.ts';
import {corpusMessages} from '../../test/helpers/ha-corpus.ts';
import {freeUdpPort} from '../../test/helpers/util.ts';

async function main(): Promise<void> {
    const broker = await startBroker();
    const dir = await mkdtemp(join(tmpdir(), 'mqtt2matter-ui-'));
    const port = await freeUdpPort();
    const raw = {
        mqtt: {url: broker.url},
        storage: join(dir, 'data'),
        log: {level: 'debug', matter: 'error'},
        bridges: {default: {port, passcode: 20202021, discriminator: 3840}},
        devices: {
            'living-room-lamp': {
                name: 'Living room lamp',
                vendor: 'Tasmota',
                model: 'Sonoff B1',
                availability: {topic: 'tele/b1/LWT', online: 'Online', offline: 'Offline'},
                endpoints: [
                    {
                        deviceTypes: ['ColorTemperatureLight'],
                        mappings: [
                            {
                                attribute: 'OnOff.onOff',
                                status: {topic: 'stat/b1/RESULT', extract: '$.POWER', map: {ON: true, OFF: false}},
                                command: {topic: 'cmnd/b1/POWER', format: {true: 'ON', false: 'OFF'}},
                            },
                            {
                                attribute: 'LevelControl.currentLevel',
                                status: {topic: 'stat/b1/RESULT', extract: '$.Dimmer', unit: 'percentLevel'},
                                command: {topic: 'cmnd/b1/Dimmer', unit: 'percentLevel', round: 0},
                            },
                            {
                                attribute: 'ColorControl.colorTemperatureMireds',
                                status: {topic: 'stat/b1/RESULT', extract: '$.CT'},
                                command: {topic: 'cmnd/b1/CT'},
                            },
                        ],
                    },
                ],
            },
            'hall-contact': {
                name: 'Hall window',
                source: {kind: 'z2m', key: '0x00124b00aaaa0001'},
                endpoints: [
                    {
                        deviceTypes: ['ContactSensor', 'PowerSource'],
                        mappings: [
                            {
                                attribute: 'BooleanState.stateValue',
                                status: {topic: 'zigbee2mqtt/hall_window', extract: 'contact', type: 'boolean'},
                            },
                            {
                                attribute: 'PowerSource.batPercentRemaining',
                                status: {topic: 'zigbee2mqtt/hall_window', extract: 'battery', unit: 'halfPercent'},
                            },
                        ],
                    },
                ],
            },
            'office-blind': {
                name: 'Office blind',
                enabled: false,
                endpoints: [
                    {
                        deviceTypes: ['WindowCovering'],
                        mappings: [
                            {
                                attribute: 'WindowCovering.currentPositionLiftPercent100ths',
                                status: {topic: 'stat/blind/position', unit: 'percent100ths'},
                            },
                            {
                                attribute: 'WindowCovering.targetPositionLiftPercent100ths',
                                command: {topic: 'cmnd/blind/position', unit: 'percent100ths'},
                            },
                        ],
                    },
                ],
            },
        },
    };
    const path = join(dir, 'mqtt2matter.json');
    await writeFile(path, JSON.stringify(raw, null, 2));
    const config = parseConfig(raw);
    const logBuffer = new LogBuffer();
    const log = createLogger('debug', (line) => {
        logBuffer.push(line);
        if (process.env.UI_SERVE_VERBOSE !== undefined) {
            console.error(line);
        }
    });
    const app = new App(config, {log, mqttConnectTimeout: 5000});
    const importer = new Z2mImporter('zigbee2mqtt', log.child('z2m'));
    // as if under systemd with a newer release on the registry; the restart only logs, the update only writes
    // its request file (nothing installs or exits here)
    const updateDir = join(dir, 'update');
    await mkdir(updateDir);
    const server = new Server({
        app,
        store: new ConfigStore({path, raw, config, overridden: ['mqtt.url']}),
        log: log.child('server'),
        logBuffer,
        version: '0.0.0-ui-test',
        host: '127.0.0.1',
        port: 0,
        importers: [importer, new HaImporter('homeassistant', log.child('ha'))],
        topics: ['#'],
        updater: new Updater({
            current: '0.0.0-ui-test',
            supervisor: 'systemd',
            updateDir,
            fetchLatest: () => Promise.resolve('0.0.1'),
        }),
        onRestart: () => {
            log.info('restart requested (the UI test stack does not exit)');
        },
    });
    await server.listen();
    await app.start();
    await server.start();
    // some retained traffic, so the topic tree and the previews have payloads
    const client = await mqtt.connectAsync(broker.url);
    await client.publishAsync('tele/b1/LWT', 'Online', {retain: true});
    await client.publishAsync('stat/b1/RESULT', '{"POWER":"ON","Dimmer":42,"CT":326}', {retain: true});
    await client.publishAsync('zigbee2mqtt/hall_window', '{"contact":true,"battery":87,"linkquality":120}', {
        retain: true,
    });
    // zigbee2mqtt's description of a home, for the adopt page
    await client.publishAsync(
        'zigbee2mqtt/bridge/devices',
        await readFile(join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'z2m', 'bridge-devices.json')),
        {retain: true},
    );
    await client.publishAsync(
        'zigbee2mqtt/bridge/groups',
        await readFile(join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'z2m', 'bridge-groups.json')),
        {retain: true},
    );
    await client.publishAsync(
        'zigbee2mqtt/Gledopto RGBCTT light I',
        '{"state":"ON","brightness":200,"color_temp":300}',
        {retain: true},
    );
    // Home Assistant discovery of a few devices (the corpus of test/fixtures/ha), retained like a broker holds it
    for (const file of ['esphome', 'tasmota', 'zigbee2mqtt']) {
        for (const message of corpusMessages(file)) {
            await client.publishAsync(message.topic, message.payload, {retain: true});
        }
    }
    // a camera whose motion binary sensor is announced without a device class: the user picks its type
    for (const message of corpusMessages('misc').filter((m) => m.topic.includes('/scrypted-65c22a2f-51/'))) {
        await client.publishAsync(message.topic, message.payload, {retain: true});
    }
    let tick = 0;
    const ticker = setInterval(() => {
        tick++;
        client.publish('sensors/outside/temperature', JSON.stringify({temperature: 18 + (tick % 5) / 10, unit: 'C'}));
    }, 2000);

    console.log(`PORT ${server.port}`);
    console.log(`DIR ${dir}`);

    let stopping = false;
    const stop = (): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        clearInterval(ticker);
        Promise.resolve()
            .then(() => client.endAsync())
            .then(() => server.close())
            .then(() => app.stop())
            .then(() => broker.close())
            .then(() => rm(dir, {recursive: true, force: true}))
            .then(
                () => process.exit(0),
                () => process.exit(1),
            );
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (process.env.UI_SERVE_STDIN === '1') {
        // the test runner holds the pipe: when it goes, so does the stack
        process.stdin.on('end', stop);
        process.stdin.on('close', stop);
        process.stdin.resume();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
