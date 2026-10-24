/* What controllers read about the bridge and its devices: BasicInformation from the package version (no
   development values), a productLabel without the vendor name, and the same for each bridged device's
   BridgedDeviceBasicInformation — and matter.js warns about none of it. The node is built, never online. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {LogDestination, Logger as MatterLogger, LogLevel} from '@matter/main';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {parseConfig} from '../src/config/load.ts';
import {createLogger} from '../src/log.ts';
import {productLabel, softwareVersionNumber} from '../src/matter/ids.ts';
import {NodeManager} from '../src/matter/node-manager.ts';
import {freeUdpPort} from './helpers/util.ts';

let storage: string;
let manager: NodeManager;
const warnings: string[] = [];

beforeAll(async () => {
    storage = await mkdtemp(join(tmpdir(), 'mqtt2matter-basic-'));
    MatterLogger.destinations.test = LogDestination({
        level: LogLevel.WARN,
        write: (text: string) => {
            warnings.push(text);
        },
    });
    const config = parseConfig({
        storage,
        log: {matter: 'warn'},
        bridges: {default: {port: await freeUdpPort()}},
        devices: {
            relay: {
                name: 'Relay',
                vendor: 'Shelly',
                model: 'Shelly Plus 1PM',
                endpoints: [{deviceTypes: ['OnOffPlugInUnit']}],
            },
            plain: {name: 'Plain', endpoints: [{deviceTypes: ['OnOffLight']}]},
        },
    });
    manager = new NodeManager({config, softwareVersion: '1.2.3', log: createLogger('error')});
    await manager.prepare();
    await manager.bridge('default')!.build();
}, 60_000);

afterAll(async () => {
    delete MatterLogger.destinations.test;
    await manager.stop();
    await rm(storage, {recursive: true, force: true});
});

describe('the helpers', () => {
    it('a growing software version number from the semver', () => {
        expect(softwareVersionNumber('0.1.0')).toBe(1_000);
        expect(softwareVersionNumber('1.2.3')).toBe(1_002_003);
        expect(softwareVersionNumber('2.0.0-beta.1')).toBe(2_000_000);
        expect(softwareVersionNumber('1.24.9')).toBeLessThan(softwareVersionNumber('2.0.0'));
    });

    it('a product label without the vendor name', () => {
        expect(productLabel('Shelly Plus 1PM', 'Shelly', 'OnOffPlugInUnit')).toBe('Plus 1PM');
        expect(productLabel('Shelly', 'Shelly', 'OnOffPlugInUnit')).toBe('OnOffPlugInUnit');
        expect(productLabel('E1757', 'IKEA', 'WindowCovering')).toBe('E1757');
        expect(productLabel(undefined, 'mqtt2matter', 'OnOffLight')).toBe('OnOffLight');
    });
});

describe('the bridge node', () => {
    it('carries the package version, a hardware version and a product label without the vendor', () => {
        const info = manager.bridge('default')!.serverNode!.state.basicInformation;
        expect(info.softwareVersion).toBe(1_002_003);
        expect(info.softwareVersionString).toBe('1.2.3');
        expect(info.hardwareVersion).toBe(1);
        expect(info.hardwareVersionString).toBe('1');
        expect(info.vendorName).toBe('mqtt2matter');
        expect(info.productLabel).toBe('MQTT to Matter bridge');
        expect(info.productLabel).not.toContain(info.vendorName);
    });

    it('the bridged devices too', () => {
        const relay = manager.handle('relay')!.state.bridgedDeviceBasicInformation!;
        expect(relay).toMatchObject({
            vendorName: 'Shelly',
            productName: 'Shelly Plus 1PM',
            productLabel: 'Plus 1PM',
            softwareVersion: 1_002_003,
            softwareVersionString: '1.2.3',
            hardwareVersion: 1,
            hardwareVersionString: '1',
        });
        expect(manager.handle('plain')!.state.bridgedDeviceBasicInformation!.productLabel).toBe('OnOffLight');
    });

    it('matter.js warns about neither development values nor the product label', () => {
        expect(warnings.filter((w) => /development values|productLabel|vendorName/.test(w))).toEqual([]);
    });
});
