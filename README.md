# mqtt2matter

A generic MQTT → Matter bridge. Compose Matter devices by hand — device types, endpoints, clusters,
attributes — and map them onto MQTT topics with configurable payloads: JSON paths, value maps, scaling,
templates. Importers add devices with one click: Zigbee2MQTT natively (`bridge/devices`) and anything that
announces itself through Home Assistant MQTT discovery (ESPHome, Tasmota, Shelly, Zwave-JS-UI, …). Built on
[matter.js](https://github.com/matter-js/matter.js) and [MQTT.js](https://github.com/mqttjs/MQTT.js).

**Status: pre-alpha.** Phase 2 of 6 — the manual model is complete: every device type matter.js ships,
composed from the Matter data model (no hand-kept catalogue), child endpoints, the payload engine in both
directions with Jinja templates, and the families — lights (level, colour temperature, xy, hue/saturation,
RGB), covers (positions, state-only, tilt), thermostats, locks, fans, buttons (GenericSwitch events), sensors,
battery, availability. `mqtt2matter --check` validates a configuration against the model and matter.js in
strict mode. The Zigbee2MQTT importer adopts `bridge/devices` and `bridge/groups` from the command line and
re-syncs them. Not published, not released; the UI and the Home Assistant discovery importer are the next
phases. The configuration schema is frozen.

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

[docs/config.md](docs/config.md) describes the configuration, [docs/architecture.md](docs/architecture.md)
the module layout and its rules.

## Looking for the other direction?

To bridge real Matter devices to MQTT, use [she](https://github.com/hobbyquaker/she) (smart home engine): it
has a built-in Matter controller and MQTT.

## Develop

```sh
npm run lint        # eslint + prettier
npm run typecheck
npm test            # vitest: unit tests, the strict dry run, and end-to-end tests with an in-process broker and matter.js node
```

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
