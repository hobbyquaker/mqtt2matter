import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {checkConfig} from '../src/matter/check.ts';
import {PresetError, applyPreset, parsePreset, placeholdersOf, presetValues} from '../src/model/presets.ts';
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

    it('resolves a default that references other variables', () => {
        const preset = parsePreset({
            ...relay,
            variables: {
                ...relay.variables,
                name: {label: 'Name', default: '%topic% %index%'},
                room: {label: 'Room', default: 'Office'},
                label: {label: 'Label', default: ' %room% / %name% '},
            },
        });
        // no name given: from the topic, the empty index trimmed away
        expect(presetValues(preset, {topic: 'plug-1'})).toEqual({
            topic: 'plug-1',
            name: 'plug-1',
            index: '',
            room: 'Office',
            label: 'Office / plug-1',
        });
        expect(presetValues(preset, {topic: 'plug-1', index: '2'}).name).toBe('plug-1 2');
        // a given name wins, and a reference to it sees the given one
        expect(presetValues(preset, {topic: 'plug-1', name: 'Desk'})).toMatchObject({
            name: 'Desk',
            label: 'Office / Desk',
        });
        expect(applyPreset(preset, {topic: 'plug-1'}).name).toBe('plug-1');
        // the referenced variable has no value and no default: missing, as when it is used directly
        expect(() => presetValues(preset, {})).toThrow(/missing values for topic/);
    });

    it('takes a referenced value with its slashes as spaces for %name|words%', () => {
        const preset = parsePreset({
            ...relay,
            variables: {...relay.variables, name: {label: 'Name', default: '%topic|words%'}},
        });
        expect(presetValues(preset, {topic: 'kitchen/ceiling//light'}).name).toBe('kitchen ceiling light');
        expect(() =>
            parsePreset({...relay, variables: {...relay.variables, name: {label: 'Name', default: '%room|words%'}}}),
        ).toThrow(/undeclared variables: room/);
    });

    it('refuses a default that references an undeclared variable or a cycle', () => {
        expect(() =>
            parsePreset({...relay, variables: {...relay.variables, name: {label: 'Name', default: '%room%'}}}),
        ).toThrow(/the default of name references undeclared variables: room/);
        expect(() =>
            parsePreset({
                ...relay,
                variables: {
                    ...relay.variables,
                    name: {label: 'Name', default: '%label%'},
                    label: {label: 'Label', default: 'x %name%'},
                },
            }),
        ).toThrow(/cycle: name → label → name/);
        expect(() =>
            parsePreset({...relay, variables: {...relay.variables, name: {label: 'Name', default: '%name%'}}}),
        ).toThrow(/cycle: name → name/);
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

    it('each gives a device applied without a name a name that identifies it, not a generic word', async () => {
        const library = await loadPresets([]);
        const cases = presetCases();
        for (const {preset} of library.presets) {
            const values = Object.fromEntries(
                Object.entries(cases.get(preset.id)!.values).filter(([v]) => v !== 'name'),
            );
            const device = applyPreset(preset, values);
            // the name is made of what the user typed: the identifying variable (and the channel) is in it
            const identifying = Object.entries(values).filter(
                ([variable]) => !['max', 'divisor', 'sensor'].includes(variable),
            );
            expect(identifying.length, preset.id).toBeGreaterThan(0);
            expect(
                identifying.some(
                    // as typed, or with its slashes as spaces (`%item|words%`)
                    ([, value]) =>
                        value !== '' &&
                        (device.name.includes(value) || device.name.includes(value.replace(/\//g, ' '))),
                ),
                `${preset.id}: "${device.name}" from ${JSON.stringify(values)}`,
            ).toBe(true);
            expect(device.name, preset.id).not.toMatch(
                /^(Switch|Light|Dimmer|Relay|Cover|Shutter|Contact|Occupancy|Temperature|Humidity|Climate|Button|Vacuum|WLED|Shelly.*)$/,
            );
            expect(device.name, preset.id).toBe(device.name.trim());
            expect(validateDevice(device).issues, preset.id).toEqual([]);
        }
    });
});
