# mqtt2matter

A generic MQTT → Matter bridge. Compose Matter devices by hand — device types, endpoints, clusters,
attributes — and map them onto MQTT topics with configurable payloads: JSON paths, value maps, scaling,
templates. Importers add devices with one click: Zigbee2MQTT natively (`bridge/devices`) and anything that
announces itself through Home Assistant MQTT discovery (ESPHome, Tasmota, Shelly, Zwave-JS-UI, …). Built on
[matter.js](https://github.com/matter-js/matter.js) and [MQTT.js](https://github.com/mqttjs/MQTT.js).

**Status: pre-alpha.** Phase 3 of 6 — the manual model is complete: every device type matter.js ships,
composed from the Matter data model (no hand-kept catalogue), child endpoints, the payload engine in both
directions with Jinja templates, and the families — lights (level, colour temperature, xy, hue/saturation,
RGB), covers (positions, state-only, tilt), thermostats, locks, fans, buttons (GenericSwitch events), sensors,
battery, availability. `mqtt2matter --check` validates a configuration against the model and matter.js in
strict mode. The Zigbee2MQTT importer adopts `bridge/devices` and `bridge/groups` from the command line or
the UI and re-syncs them. The web UI edits devices and mappings with a live preview, adopts discovered
devices, shows the pairing code and the live MQTT traffic. Not published, not released; the Home Assistant
discovery importer adopts ESPHome, Tasmota, Shelly, Z-Wave JS UI, OpenMQTTGateway and the device-based
form from the UI. The configuration schema is frozen.

## Try it

Node ≥ 22.13.

```sh
npm ci
npm run build
cp example/mqtt2matter.json .      # edit topics and payloads
node dist/main.js mqtt2matter.json
```

`node dist/main.js --check mqtt2matter.json` checks the devices without starting the bridge. The log shows
the bridge's manual pairing code and QR payload while it is not commissioned. Pair it from Apple Home, Home
Assistant, Google Home or Alexa like any Matter bridge; the devices appear as bridged endpoints.

### The web UI

The bridge serves its UI on port 8282 (`server.port`): the device list, an editor for devices and their
mappings with a live preview of every conversion step in both directions and a topic picker over the broker's
live topic tree, presets, the adopt page for devices Zigbee2MQTT describes, the bridges with their QR code
and pairing code, the live MQTT traffic, the log, the strict dry run, import and export. German and English,
light and dark. `server.enabled: false` turns it off; [docs/api.md](docs/api.md) is the API it uses.

> **The UI has no login by default** (`server.auth.mode: "none"`), so an existing installation keeps working as it
> is: whoever reaches port 8282 can change the bridge. Set a password on the Configuration page (Access), or let a
> reverse proxy authenticate (`proxy` mode, the user in a header such as `X-Remote-User`) —
> [docs/config.md](docs/config.md#access).

### Zigbee2MQTT

```sh
node dist/main.js --import-z2m mqtt2matter.json            # reads zigbee2mqtt/bridge/devices and /groups
node dist/main.js --import-z2m mqtt2matter.json --dry-run  # shows what it would do
node dist/main.js mqtt2matter.json                         # starts the bridge, logs the pairing code
```

`--import-z2m` connects to the broker of the configuration (or `MQTT2MATTER_MQTT_URL`), reads the retained
`bridge/devices` and `bridge/groups` (`--base-topic` for another base topic), writes every supported device
and group into the file as ordinary devices — lights, switches, covers, locks, thermostats, fans, sensors,
buttons as GenericSwitch endpoints, battery, availability — and prints one line per device with what it could
not map. Edit the result like any other device; running the import again carries your edits over, lists
conflicts instead of resolving them, and marks devices that left zigbee2mqtt as orphaned without removing
them. [docs/importers.md](docs/importers.md) has the mapping and the API.

### Home Assistant MQTT discovery

Anything that announces itself under `homeassistant/#` — ESPHome, Tasmota, Shelly, Z-Wave JS UI,
OpenMQTTGateway, the device-based form with components — appears on the Adopt page while the bridge runs
(`importers.ha` in the configuration): one Matter device per Home Assistant device, the primary entity on
its own endpoint, the other entities as children, a suggested area as a Matter area tag, templates through
the payload engine where it can run them and listed with the template where it cannot. What has no Matter
equivalent (`number`, `select`, `button`, settings and diagnostics) is listed, not dropped. A device that
zigbee2mqtt announces itself is marked as a duplicate of its native description, which is the better one: the
bridge adopts one device twice only when you confirm it.

[docs/config.md](docs/config.md) describes the configuration, [docs/architecture.md](docs/architecture.md)
the module layout and its rules.

## Install on a Linux host

mqtt2matter runs as the systemd service `mqtt2matter.service` under a system user of its own:

| What               | Where                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| the package        | `/usr/local/lib/node_modules/mqtt2matter`, the command `/usr/local/bin/mqtt2matter`   |
| the configuration  | `/etc/mqtt2matter/mqtt2matter.json` (the UI edits it)                                 |
| the Matter storage | `/var/lib/mqtt2matter` — the pairings; keep it, or every controller has to pair again |
| the log            | `journalctl -u mqtt2matter -f` — the pairing code and QR payload are there            |

From a checkout, `deploy.sh` does all of it over ssh: lint, typecheck and tests (`SKIP_TESTS=1` skips them),
build, `npm pack`, copy the tarball and the lock file, install with `npm install --omit=dev`, link the
command, and run `--install` again on a host that has the service (the units follow the version, the service
restarts). It checks the host's Node against `engines` before anything is copied.

```sh
INSTALL=1 MQTT_URL=mqtt://broker:1883 npm run deploy -- root@my-host   # the first time: also installs the service
npm run deploy -- root@my-host                                         # later: update and restart
```

The host defaults to `mqtt2matter` (an ssh host name or a `Host` alias in `~/.ssh/config`). By hand, on the
host: `npm install -g ./mqtt2matter-<version>.tgz`, then `sudo mqtt2matter --install --mqtt-url
mqtt://broker:1883`. `--install` creates the user and the directories, writes the configuration only when there
is none, writes the unit and enables and starts it; running it again rewrites the unit (after a Node update,
say, or after an update that needs a new unit). `--install --dry-run` shows what it would write.
`mqtt2matter --uninstall` removes the service and keeps the configuration and the storage.

**Restart and update from the UI** (Configuration → Version) work under this service. A restart exits with code
75, which the unit restarts on (`RestartForceExitStatus=75`) and counts as a clean stop
(`SuccessExitStatus=75`). An update installs the registry's latest `mqtt2matter` the way it was installed,
globally with npm — which the service user may not do: the UI only writes
the version into `/var/lib/mqtt2matter/update/request`, and `--install` sets up `mqtt2matter-update.path`, which
starts the root oneshot `mqtt2matter-update.service` (`mqtt2matter --apply-update`): it installs exactly
`mqtt2matter@<that version>`, logs to `/var/lib/mqtt2matter/update/update.log` (shown in the UI) and restarts
the service. No sudo rule, no polkit. Until mqtt2matter is on npm, the UI says "not published" and only the
restart works. Outside the service (by hand, Docker) the UI offers neither and says why.

**The host needs:**

- Node ≥ 22.13 with npm, installed system-wide (`/usr/bin` or `/usr/local/bin` — the unit runs with
  `ProtectHome`, so a Node under `/root` or `/home`, as nvm installs it, does not start), systemd, and ssh as
  root or with sudo for `deploy.sh`.
- **The same layer-2 network as the Matter controllers**: Matter finds the bridge through mDNS (UDP 5353,
  multicast `224.0.0.251` and `ff02::fb`) and talks to it over IPv6. In a container, that means a bridged
  network interface (not NAT) with IPv6 enabled — link-local addresses at least, SLAAC when the network has
  it — and multicast passed through.
- No firewall on UDP 5353 (mDNS), UDP 5540 (`bridges.<id>.port`, one port per bridge) and TCP 8282 (the UI,
  `server.port`), or rules that let them in.

## Looking for the other direction?

To bridge real Matter devices to MQTT, use [she](https://github.com/hobbyquaker/she) (smart home engine): it
has a built-in Matter controller and MQTT.

## Develop

```sh
npm run lint        # eslint + prettier
npm run typecheck
npm test            # vitest: unit tests, the strict dry run, and end-to-end tests with an in-process broker and matter.js node
npm run test:e2e    # Playwright: the UI against the real stack on ephemeral ports (Chromium in CI, Firefox elsewhere; PW_BROWSER overrides)
npm run dev:ui      # Vite with hot reload, the API proxied to a running mqtt2matter on 127.0.0.1:8282 (UI_API overrides)
```

`node ui/test/serve.ts` starts a throw-away stack — broker, bridge, UI, zigbee2mqtt's test corpus — on an
ephemeral port it prints, for a look at the UI without a configuration of your own.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
