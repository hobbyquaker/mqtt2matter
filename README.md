# mqtt2matter

A generic MQTT → Matter bridge. Compose Matter devices by hand — device types, endpoints, clusters,
attributes — and map them onto MQTT topics with configurable payloads: JSON paths, value maps, scaling,
templates. Importers add devices with one click: Zigbee2MQTT natively (`bridge/devices`) and anything that
announces itself through Home Assistant MQTT discovery (ESPHome, Tasmota, Shelly, Zwave-JS-UI, …). Built on
[matter.js](https://github.com/matter-js/matter.js) and [MQTT.js](https://github.com/mqttjs/MQTT.js).

**Status: pre-alpha.** Phase 1 of 6 — the manual model is complete: every device type matter.js ships,
composed from the Matter data model (no hand-kept catalogue), child endpoints, the payload engine in both
directions with Jinja templates, and the families — lights (level, colour temperature, xy, hue/saturation,
RGB), covers (positions, state-only, tilt), thermostats, locks, fans, buttons (GenericSwitch events), sensors,
battery, availability. `mqtt2matter --check` validates a configuration against the model and matter.js in
strict mode. Not published, not released; the importers (Zigbee2MQTT, Home Assistant discovery) and the UI
are the next phases. The configuration schema is frozen.

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
