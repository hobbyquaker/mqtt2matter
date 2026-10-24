/* The strict dry run: a throw-away node in its own environment, nothing online. */

import {describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {checkConfig, formatCheck} from '../src/matter/check.ts';

describe('checkConfig', () => {
    it('passes conformant devices and reports the rest without touching the network', async () => {
        const config = parseConfig({
            log: {matter: 'error'},
            devices: {
                light: {
                    name: 'Light',
                    endpoints: [
                        {
                            deviceTypes: ['ColorTemperatureLight'],
                            bindings: [{attribute: 'ColorControl.colorHs', status: {topic: 's'}}],
                        },
                    ],
                },
                child: {
                    name: 'Two',
                    endpoints: [{deviceTypes: ['OnOffLight']}, {id: 'l2', deviceTypes: ['OnOffLight']}],
                },
                sensor: {
                    name: 'Sensor',
                    endpoints: [
                        {
                            deviceTypes: ['TemperatureSensor', 'PowerSource'],
                            bindings: [{attribute: 'PowerSource.batPercentRemaining', status: {topic: 's'}}],
                        },
                    ],
                },
                badType: {name: 'Bad', endpoints: [{deviceTypes: ['Nonsense']}]},
                badAttribute: {
                    name: 'Bad',
                    endpoints: [
                        {
                            deviceTypes: ['OnOffLight'],
                            bindings: [{attribute: 'OnOff.brightness', status: {topic: 's'}}],
                        },
                    ],
                },
                disabled: {name: 'Off', enabled: false, endpoints: [{deviceTypes: ['Nonsense']}]},
            },
        });
        const result = await checkConfig(config);
        expect(result.ok).toBe(false);
        expect([...result.devices.keys()].sort()).toEqual(['badAttribute', 'badType', 'disabled']);
        expect(result.devices.get('badType')!.map((i) => i.message)).toEqual([
            expect.stringContaining('not in the Matter model'),
            expect.stringContaining('not known to matter.js'),
        ]);
        expect(result.devices.get('disabled')!.map((i) => i.level)).toEqual(['error']);
        const lines = formatCheck(result);
        expect(lines.at(-1)).toBe('not ok');
        expect(lines.some((l) => l.startsWith('ERROR badAttribute endpoints[0].bindings[0]'))).toBe(true);

        const good = await checkConfig(
            parseConfig({log: {matter: 'error'}, devices: {light: config.devices.light, child: config.devices.child}}),
        );
        expect(good.ok).toBe(true);
        expect(good.devices.size).toBe(0);
    });

    it('reports what strict matter.js refuses', async () => {
        // a light whose LevelControl is configured without the OnOff feature the device type demands
        const config = parseConfig({
            log: {matter: 'error'},
            devices: {
                dim: {
                    name: 'Dim',
                    endpoints: [{deviceTypes: ['OnOffLight'], attributes: {OnOff: {startUpOnOff: 99}}}],
                },
            },
        });
        const result = await checkConfig(config);
        expect(result.ok).toBe(false);
        expect(
            result.devices
                .get('dim')!
                .map((i) => i.message)
                .join(' '),
        ).toMatch(/startUpOnOff|99/);
    });
});
