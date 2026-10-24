/* `--install` / `--uninstall` against a temporary root with a fake host: the files written, the commands run,
   and what is kept. Nothing touches systemd or the real /etc. */

import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
    CONFIG_FILE,
    type InstallHost,
    initialConfig,
    parseInstallArgs,
    runInstall,
    STATE_DIR,
    UNIT_PATH,
    unitFile,
} from '../src/commands/install.ts';
import {parseConfig} from '../src/config/index.ts';

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mqtt2matter-install-'));
});

afterEach(async () => {
    await rm(root, {recursive: true, force: true});
});

function fakeHost(options: {userExists?: boolean; unsuitable?: string} = {}) {
    const commands: string[] = [];
    const lines: string[] = [];
    const host: InstallHost = {
        root,
        execStart: '/usr/bin/node /usr/local/lib/node_modules/mqtt2matter/dist/main.js',
        exec: (command, args) => {
            commands.push([command, ...args].join(' '));
        },
        succeeds: (command, args) => {
            commands.push([command, ...args].join(' '));
            return options.userExists ?? false;
        },
        unsuitable: () => options.unsuitable,
        out: (line) => lines.push(line),
    };
    return {host, commands, lines};
}

describe('parseInstallArgs', () => {
    it('takes the broker, dry run and uninstall', () => {
        expect(parseInstallArgs(['--install', '--mqtt-url', 'mqtt://broker:1883', '--dry-run'])).toEqual({
            uninstall: false,
            dryRun: true,
            mqttUrl: 'mqtt://broker:1883',
        });
        expect(parseInstallArgs(['--install', '--mqtt-url=mqtt://b'])).toMatchObject({mqttUrl: 'mqtt://b'});
        expect(parseInstallArgs(['--uninstall'])).toEqual({uninstall: true, dryRun: false});
        expect(() => parseInstallArgs(['--install', '--name', 'x'])).toThrow('unknown option --name');
        expect(() => parseInstallArgs(['--install', '--mqtt-url'])).toThrow('--mqtt-url needs a URL');
    });
});

describe('the unit and the first configuration', () => {
    it('runs as its own user with the configuration and the storage in their places', () => {
        const unit = unitFile('/usr/bin/node /x/dist/main.js');
        expect(unit).toContain('ExecStart=/usr/bin/node /x/dist/main.js\n');
        expect(unit).toContain('User=mqtt2matter\n');
        expect(unit).toContain('Environment=MQTT2MATTER_CONFIG=/etc/mqtt2matter/mqtt2matter.json\n');
        expect(unit).toContain('StateDirectory=mqtt2matter\n');
        expect(unit).toContain('ReadWritePaths=/etc/mqtt2matter\n');
        expect(unit).toContain('Restart=on-failure\n');
        expect(unit).toContain('WantedBy=multi-user.target\n');
    });

    it('is a valid configuration with the storage under /var/lib', () => {
        const config = parseConfig(JSON.parse(initialConfig('mqtt://broker:1883')));
        expect(config.mqtt.url).toBe('mqtt://broker:1883');
        expect(config.storage).toBe(STATE_DIR);
        expect(parseConfig(JSON.parse(initialConfig(undefined))).mqtt.url).toBe('mqtt://localhost:1883');
    });
});

describe('--install', () => {
    it('creates the user, the directories, the configuration and the unit, then enables and starts it', async () => {
        const {host, commands} = fakeHost();
        await runInstall({uninstall: false, dryRun: false, mqttUrl: 'mqtt://broker:1883'}, host);
        expect(await readFile(join(root, UNIT_PATH), 'utf8')).toBe(unitFile(host.execStart));
        expect(JSON.parse(await readFile(join(root, CONFIG_FILE), 'utf8'))).toMatchObject({
            mqtt: {url: 'mqtt://broker:1883'},
            storage: '/var/lib/mqtt2matter',
        });
        expect((await stat(join(root, CONFIG_FILE))).mode & 0o777).toBe(0o640);
        expect((await stat(join(root, STATE_DIR))).isDirectory()).toBe(true);
        expect(commands).toEqual([
            'id -u mqtt2matter',
            'useradd --system --no-create-home --home-dir /var/lib/mqtt2matter --shell /usr/sbin/nologin mqtt2matter',
            `chown -R mqtt2matter:mqtt2matter ${join(root, '/etc/mqtt2matter')} ${join(root, STATE_DIR)}`,
            'systemctl daemon-reload',
            'systemctl enable mqtt2matter.service',
            'systemctl restart mqtt2matter.service',
        ]);
    });

    it('keeps an existing configuration and an existing user', async () => {
        await mkdir(join(root, '/etc/mqtt2matter'), {recursive: true});
        await writeFile(join(root, CONFIG_FILE), '{"mqtt": {"url": "mqtt://mine"}}\n');
        const {host, commands, lines} = fakeHost({userExists: true});
        await runInstall({uninstall: false, dryRun: false, mqttUrl: 'mqtt://other'}, host);
        expect(await readFile(join(root, CONFIG_FILE), 'utf8')).toBe('{"mqtt": {"url": "mqtt://mine"}}\n');
        expect(commands.some((c) => c.startsWith('useradd'))).toBe(false);
        expect(lines).toContain(`kept ${CONFIG_FILE}`);
        expect(lines.some((l) => l.startsWith('--mqtt-url ignored'))).toBe(true);
    });

    it('refuses on an unsuitable host and writes nothing', async () => {
        const {host, commands} = fakeHost({unsuitable: 'needs root: sudo mqtt2matter --install'});
        await expect(runInstall({uninstall: false, dryRun: false}, host)).rejects.toThrow('--install: needs root');
        expect(commands).toEqual([]);
        await expect(stat(join(root, UNIT_PATH))).rejects.toThrow();
    });

    it('--dry-run only prints', async () => {
        const {host, commands, lines} = fakeHost({unsuitable: 'needs root'});
        await runInstall({uninstall: false, dryRun: true}, host);
        expect(commands).toEqual([]);
        expect(lines.join('\n')).toContain('ExecStart=/usr/bin/node');
        expect(lines.join('\n')).toContain(`would create ${CONFIG_FILE}`);
        await expect(stat(join(root, UNIT_PATH))).rejects.toThrow();
    });
});

describe('--uninstall', () => {
    it('removes the unit and keeps the configuration and the storage', async () => {
        const {host} = fakeHost();
        await runInstall({uninstall: false, dryRun: false}, host);
        const {host: again, commands} = fakeHost({userExists: true});
        await runInstall({uninstall: true, dryRun: false}, again);
        expect(commands).toEqual(['systemctl disable --now mqtt2matter.service', 'systemctl daemon-reload']);
        await expect(stat(join(root, UNIT_PATH))).rejects.toThrow();
        expect((await stat(join(root, CONFIG_FILE))).isFile()).toBe(true);
        expect((await stat(join(root, STATE_DIR))).isDirectory()).toBe(true);
    });
});
