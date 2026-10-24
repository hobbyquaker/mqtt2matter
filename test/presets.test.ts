import {describe, expect, it} from 'vitest';

import {PresetError, applyPreset, parsePreset, placeholdersOf} from '../src/model/presets.ts';

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
                bindings: [
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
        const binding = device.endpoints[0]!.bindings[0]!;
        expect(binding.status?.topic).toBe('stat/sonoff-1/RESULT');
        expect(binding.status?.extract).toBe('$.POWER');
        expect(binding.command?.topic).toBe('cmnd/sonoff-1/POWER');
        expect(device.source).toEqual({kind: 'preset', key: 'tasmota/relay', version: '1'});
        expect(
            applyPreset(parsePreset(relay), {topic: 't', index: '2'}).endpoints[0]!.bindings[0]!.command?.topic,
        ).toBe('cmnd/t/POWER2');
    });

    it('reports missing values and an invalid result', () => {
        expect(() => applyPreset(parsePreset(relay), {})).toThrow(/missing values for topic/);
        expect(() => applyPreset(parsePreset({...relay, device: {...relay.device, name: ''}}), {topic: 't'})).toThrow(
            /the device is invalid/,
        );
    });
});
