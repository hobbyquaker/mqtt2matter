import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {checkConfig} from '../src/matter/check.ts';
import {PresetError, applyPreset, parsePreset, placeholdersOf} from '../src/model/presets.ts';
import {validateDevice} from '../src/model/validate.ts';
import {loadPresets} from '../src/server/presets.ts';
import {deviceKeyOf, presetCases} from './helpers/preset-fixtures.ts';

const relay = {
    id: 'tasmota/relay',
    name: 'Tasmota relay',
    vendor: 'Tasmota',
    variables: {
        topic: {label: 'Tasmota topic', description: 'the %topic% of the device'},
        name: {label: 'Name', default: 'Relay'},
        index: {label: 'Relay index', default: '', optional: true},
    },
    device: {
        name: '%name%',
        vendor: 'Tasmota',
        availability: {topic: 'tele/%topic%/LWT', online: 'Online', offline: 'Offline'},
        endpoints: [
            {
                deviceTypes: ['OnOffPlugInUnit'],
                mappings: [
                    {
                        attribute: 'OnOff.onOff',
                        status: {topic: 'stat/%topic%/RESULT', extract: '$.POWER%index%', map: {ON: true, OFF: false}},
                        command: {topic: 'cmnd/%topic%/POWER%index%', format: {true: 'ON', false: 'OFF'}},
                    },
                ],
            },
        ],
    },
};

describe('presets', () => {
    it('parses a preset and lists its placeholders', () => {
        const preset = parsePreset(relay);
        expect(preset.format).toBe(1);
        expect(placeholdersOf(preset)).toEqual(['index', 'name', 'topic']);
    });

    it('refuses undeclared placeholders and bad ids', () => {
        expect(() => parsePreset({...relay, device: {name: '%nope%'}})).toThrow(
            /placeholders without a variable: nope/,
        );
        expect(() => parsePreset({...relay, id: 'Tasmota Relay'})).toThrow(PresetError);
    });

    it('substitutes the values and yields a valid device with its source', () => {
        const device = applyPreset(parsePreset(relay), {topic: 'sonoff-1', name: 'Kitchen "plug"'});
        expect(device.name).toBe('Kitchen "plug"');
        expect(device.availability).toEqual({
            topics: [{topic: 'tele/sonoff-1/LWT', online: 'Online', offline: 'Offline'}],
            mode: 'latest',
        });
        const mapping = device.endpoints[0]!.mappings[0]!;
        expect(mapping.status?.topic).toBe('stat/sonoff-1/RESULT');
        expect(mapping.status?.extract).toBe('$.POWER');
        expect(mapping.command?.topic).toBe('cmnd/sonoff-1/POWER');
        expect(device.source).toEqual({kind: 'preset', key: 'tasmota/relay', version: '1'});
        expect(
            applyPreset(parsePreset(relay), {topic: 't', index: '2'}).endpoints[0]!.mappings[0]!.command?.topic,
        ).toBe('cmnd/t/POWER2');
    });

    it('reports missing values and an invalid result', () => {
        expect(() => applyPreset(parsePreset(relay), {})).toThrow(/missing values for topic/);
        expect(() => applyPreset(parsePreset({...relay, device: {...relay.device, name: ''}}), {topic: 't'})).toThrow(
            /the device is invalid/,
        );
    });
});

describe('the shipped presets', () => {
    it('all load, each has a fixture case, and each applied preset validates and passes the strict dry run', async () => {
        const library = await loadPresets([]);
        expect(library.problems).toEqual([]);
        const cases = presetCases();
        const ids = library.presets.map((p) => p.preset.id).sort();
        expect(ids).toEqual([...cases.keys()].sort());
        const devices: Record<string, unknown> = {};
        for (const {preset, file} of library.presets) {
            expect(file.endsWith(`${preset.id}.json`), `${preset.id} lives in ${file}`).toBe(true);
            expect(preset.description, preset.id).toBeTruthy();
            const device = applyPreset(preset, cases.get(preset.id)!.values);
            const validation = validateDevice(device);
            expect(validation.issues, preset.id).toEqual([]);
            devices[deviceKeyOf(preset.id)] = device;
        }
        const result = await checkConfig(parseConfig({log: {matter: 'error'}, devices}));
        expect(Object.fromEntries(result.devices)).toEqual({});
        expect(result.ok).toBe(true);
    });
});
