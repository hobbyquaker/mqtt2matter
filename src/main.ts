#!/usr/bin/env node
/* `mqtt2matter [config.json]`: load the configuration, start, stop on SIGINT/SIGTERM. */

import {App, VERSION} from './app.ts';
import {ConfigError, loadConfig} from './config/load.ts';
import {createLogger, describeError} from './log.ts';

async function main(): Promise<void> {
    const arg = process.argv[2];
    if (arg === '--help' || arg === '-h') {
        console.log(
            `mqtt2matter ${VERSION}\nusage: mqtt2matter [config.json]\n  the file defaults to $MQTT2MATTER_CONFIG, then ./mqtt2matter.json`,
        );
        return;
    }
    if (arg === '--version' || arg === '-v') {
        console.log(VERSION);
        return;
    }
    const {config, path, fromFile} = await loadConfig();
    const log = createLogger(config.log.level);
    log.info(`mqtt2matter ${VERSION}, ${fromFile ? `configuration ${path}` : `no ${path}, defaults`}`);
    const app = new App(config, {log});
    let stopping = false;
    const stop = (signal: string): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        log.info(`${signal}, stopping`);
        app.stop().then(
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
}

main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
        console.error(error.message);
    } else {
        console.error(`mqtt2matter failed to start: ${describeError(error)}`);
    }
    process.exit(1);
});
