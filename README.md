# mqtt2matter

A generic MQTT → Matter bridge. Compose Matter devices by hand — device types, endpoints, clusters,
attributes — and map them onto MQTT topics with configurable payloads: JSON paths, value maps, scaling,
templates. Importers add devices with one click: Zigbee2MQTT natively (`bridge/devices`) and anything that
announces itself through Home Assistant MQTT discovery (ESPHome, Tasmota, Shelly, Zwave-JS-UI, …). Built on
[matter.js](https://github.com/matter-js/matter.js) and [MQTT.js](https://github.com/mqttjs/MQTT.js).

**Status: pre-alpha.** Phase 0 of 6 — the skeleton: configuration, the MQTT connection, a Matter bridge
with stable endpoint ids, and one device type end to end (`OnOffPlugInUnit` / `OnOffLight` bound to a
status/command topic pair). Not published, not released; the configuration shape may still change.

## Try it

Node ≥ 22.13.

```sh
npm ci
npm run build
cp example/mqtt2matter.json .      # edit topics and payloads
node dist/main.js mqtt2matter.json
```

The log shows the bridge's manual pairing code and QR payload while it is not commissioned. Pair it from
Apple Home, Home Assistant, Google Home or Alexa like any Matter bridge; the devices appear as bridged
endpoints.

[docs/config.md](docs/config.md) describes the configuration, [docs/architecture.md](docs/architecture.md)
the module layout and its rules.

## Develop

```sh
npm run lint        # eslint + prettier
npm run typecheck
npm test            # vitest: unit tests and an end-to-end test with an in-process broker and matter.js node
```

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
