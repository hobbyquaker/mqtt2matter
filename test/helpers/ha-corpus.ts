/* The Home Assistant discovery corpus of test/fixtures/ha (see its README) fed to a source. */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {ha} from '../../src/importers/index.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'ha');

interface Message {
    topic: string;
    payload: unknown;
}

export const CORPUS = [
    'esphome',
    'meter-digitizer',
    'zigbee2mqtt',
    'device-based',
    'misc',
    'tasmota',
    'shelly',
    'zwave-js-ui',
    'openmqttgateway',
];

/** the messages of a fixture file */
export function corpusMessages(file: string): {topic: string; payload: string}[] {
    const messages = JSON.parse(readFileSync(join(fixtures, `${file}.json`), 'utf8')) as Message[];
    return messages.map((m) => ({
        topic: m.topic,
        payload: typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload),
    }));
}

export function loadCorpus(source: ha.HaSource, ...files: string[]): void {
    for (const file of files) {
        for (const message of corpusMessages(file)) {
            source.handle(message.topic, message.payload);
        }
    }
}
