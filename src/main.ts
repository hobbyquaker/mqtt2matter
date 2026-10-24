#!/usr/bin/env node
/* `mqtt2matter [config.json]`: load the configuration, start, stop on SIGINT/SIGTERM. */

import {App, VERSION} from './app.ts';
import {importZ2m, parseImportArgs} from './commands/import-z2m.ts';
import {ConfigError, loadConfig} from './config/load.ts';
import {createLogger, describeError} from './log.ts';
import {checkConfig, formatCheck} from './matter/check.ts';
import {ConfigStore, type Importer, LogBuffer, Server, Z2mImporter} from './server/index.ts';

async function main(): Promise<void> {
    const arg = process.argv[2];
    if (arg === '--help' || arg === '-h') {
        console.log(
            `mqtt2matter ${VERSION}\nusage: mqtt2matter [config.json]\n       mqtt2matter --check [config.json]   validate the devices against the Matter model and matter.js (strict), no network\n       mqtt2matter --import-z2m [config.json] [--base-topic zigbee2mqtt] [--dry-run] [--no-groups] [--timeout 15]\n                                           adopt the devices and groups zigbee2mqtt describes into the file, re-sync the adopted ones\n  the file defaults to $MQTT2MATTER_CONFIG, then ./mqtt2matter.json`,
        );
        return;
    }
    if (arg === '--import-z2m') {
        const code = await importZ2m(parseImportArgs(process.argv.slice(3)), {
            out: (line) => {
                console.log(line);
            },
            log: createLogger('warn'),
        });
        process.exit(code);
    }
    if (arg === '--check') {
        const {config, path} = await loadConfig({
            ...(process.argv[3] === undefined ? {} : {path: process.argv[3]}),
        });
        console.error(`checking ${path}`);
        const result = await checkConfig(config);
        for (const line of formatCheck(result)) {
            console.log(line);
        }
        process.exit(result.ok ? 0 : 1);
    }
    if (arg === '--version' || arg === '-v') {
        console.log(VERSION);
        return;
    }
    const {config, path, fromFile, raw, overridden} = await loadConfig();
    const logBuffer = new LogBuffer();
    const log = createLogger(config.log.level, (line) => {
        console.error(line);
        logBuffer.push(line);
    });
    log.info(`mqtt2matter ${VERSION}, ${fromFile ? `configuration ${path}` : `no ${path}, defaults`}`);
    const app = new App(config, {log});
    let server: Server | undefined;
    if (config.server.enabled) {
        const importers: Importer[] = [];
        if (config.importers.z2m.enabled) {
            importers.push(new Z2mImporter(config.importers.z2m.baseTopic, log.child('z2m')));
        }
        server = new Server({
            app,
            store: new ConfigStore({path, raw, config, overridden}),
            log: log.child('server'),
            logBuffer,
            version: VERSION,
            host: config.server.host,
            port: config.server.port,
            topics: config.server.topics,
            importers,
        });
        // the UI is reachable before the broker and the bridges are up, so a wrong setting can be fixed there
        await server.listen();
    }
    let stopping = false;
    const stop = (signal: string): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        log.info(`${signal}, stopping`);
        Promise.resolve(server?.close())
            .then(() => app.stop())
            .then(
                () => process.exit(0),
                (error: unknown) => {
                    log.error('stop failed', error);
                    process.exit(1);
                },
            );
    };
    process.on('SIGINT', () => {
        stop('SIGINT');
    });
    process.on('SIGTERM', () => {
        stop('SIGTERM');
    });
    await app.start();
    await server?.start();
}

main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
        console.error(error.message);
    } else {
        console.error(`mqtt2matter failed to start: ${describeError(error)}`);
    }
    process.exit(1);
});
