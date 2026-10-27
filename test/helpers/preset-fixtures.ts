/* The preset fixtures of test/fixtures/presets (see its README): per shipped preset the values it is applied
   with and the messages the end-to-end test plays. */

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'presets');

export type Payload = string | Record<string, unknown> | unknown[];

export interface StatusCase {
    topic: string;
    payload: Payload;
    /** the endpoint id within the device; default `main` */
    endpoint?: string;
    /** `behavior.attribute` → the value it must have (objects: a subset) */
    expect?: Record<string, unknown>;
    /** switch event names that must follow, in this order */
    events?: string[];
}

export interface CommandCase {
    endpoint?: string;
    /** what the controller does, see test/presets.e2e.test.ts */
    action: string;
    args?: Record<string, number>;
    /** the messages that must be published; a JSON payload is compared as JSON */
    publishes: {topic: string; payload: Payload}[];
}

export interface PresetCase {
    values: Record<string, string>;
    availability?: {topic: string; payload: Payload; reachable: boolean}[];
    status?: StatusCase[];
    commands?: CommandCase[];
}

export interface PresetFixture {
    documentation: string[];
    presets: Record<string, PresetCase>;
}

/** preset id → its case, over every fixture file */
export function presetCases(): Map<string, PresetCase> {
    const cases = new Map<string, PresetCase>();
    for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
        const fixture = JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as PresetFixture;
        for (const [id, presetCase] of Object.entries(fixture.presets)) {
            if (cases.has(id)) {
                throw new Error(`${file}: preset ${id} has a case already`);
            }
            cases.set(id, presetCase);
        }
    }
    return cases;
}

export function payloadText(payload: Payload): string {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/** a preset id as a device key: `tasmota/relay` → `tasmota-relay` */
export function deviceKeyOf(id: string): string {
    return id.replaceAll('/', '-');
}
