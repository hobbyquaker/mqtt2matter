# Configuration

A JSON file — `mqtt2matter [config.json]`, else `$MQTT2MATTER_CONFIG`, else `./mqtt2matter.json` — with
the environment on top. Every object is strict: an unknown key is an error. Every field has a default; an
empty file (or none) starts a bridge on port 5540 with no devices. `example/mqtt2matter.json` is a complete
example.

**This is the phase 0 subset.** Phase 1 adds the rest of the payload engine (scale, unit, wrap, templates,
coalescing), cluster features, family options, child endpoints, events and commands that are not attribute
writes; the shape below stays.

## Environment

| Variable                       | Overrides       |
| ------------------------------ | --------------- |
| `MQTT2MATTER_CONFIG`           | the file path   |
| `MQTT2MATTER_MQTT_URL`         | `mqtt.url`      |
| `MQTT2MATTER_MQTT_USERNAME`    | `mqtt.username` |
| `MQTT2MATTER_MQTT_PASSWORD`    | `mqtt.password` |
| `MQTT2MATTER_MQTT_CLIENT_ID`   | `mqtt.clientId` |
| `MQTT2MATTER_STORAGE`          | `storage`       |
| `MQTT2MATTER_LOG_LEVEL`        | `log.level`     |
| `MQTT2MATTER_MATTER_LOG_LEVEL` | `log.matter`    |

## Top level

| Key                                               | Default                 | Meaning                                                         |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `mqtt.url`                                        | `mqtt://localhost:1883` | `mqtt://`, `mqtts://`, `ws://`, `wss://` as mqtt.js takes it    |
| `mqtt.username`, `mqtt.password`, `mqtt.clientId` | —                       | credentials; a random client id when unset                      |
| `storage`                                         | `./data`                | matter.js storage (fabrics, endpoint numbers) and `shards.json` |
| `log.level`                                       | `info`                  | `debug`, `info`, `warn`, `error`                                |
| `log.matter`                                      | `warn`                  | matter.js' own log level                                        |
| `vendorId`                                        | `0xFFF1`                | the Matter test vendor id                                       |
| `productId`                                       | `0x8000`                | bridge n gets `productId + n`                                   |
| `bridges`                                         | `{"default": {}}`       | one entry per Matter bridge, see below; at least one            |
| `devices`                                         | `{}`                    | one entry per device, keyed by the **device key**               |

## Bridges

```json
"bridges": {"default": {"name": "mqtt2matter", "port": 5540, "passcode": 20202021, "discriminator": 3840, "maxDevices": 0}}
```

| Key             | Default            | Meaning                                                                   |
| --------------- | ------------------ | ------------------------------------------------------------------------- |
| `name`          | `mqtt2matter <id>` | what controllers show (≤ 32 characters)                                   |
| `port`          | `5540`             | the UDP port; several bridges need distinct ports                         |
| `passcode`      | random, persisted  | 1–99999998, not one of the forbidden values                               |
| `discriminator` | random, persisted  | 0–4095                                                                    |
| `maxDevices`    | `0` (unlimited)    | devices this bridge takes before the next one is used (multi-bridge, 1.1) |

The bridge id (`default`) is the matter.js node id and its storage directory: 1–32 characters of
`A–Z a–z 0–9 _ -`. Pairing codes are logged at start while the bridge is not commissioned.

## Devices

```json
"living-room-plug": {
  "name": "Living room plug", "vendor": "Tasmota", "model": "Sonoff S26",
  "endpoints": [{
    "deviceTypes": ["OnOffPlugInUnit"],
    "bindings": [{
      "attribute": "OnOff.onOff",
      "status":  {"topic": "stat/s26/RESULT", "extract": "$.POWER", "map": {"ON": true, "OFF": false}},
      "command": {"topic": "cmnd/s26/POWER", "format": {"true": "ON", "false": "OFF"}}
    }]
  }]
}
```

The **device key** (`living-room-plug`) is the Matter endpoint id: 1–64 characters of `A–Z a–z 0–9 : . _ -`.
It keeps the device's endpoint number stable; rename through `name`, never through the key.

| Key                         | Default              | Meaning                                                                        |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `name`                      | required             | the label controllers show (≤ 32)                                              |
| `vendor`, `model`, `serial` | —                    | `BridgedDeviceBasicInformation`; the serial defaults to the key                |
| `enabled`                   | `true`               | a disabled device is not built                                                 |
| `bridge`                    | assigned             | the bridge id; default: assigned once and remembered in `shards.json`          |
| `source`                    | `{"kind": "manual"}` | where the device came from (`manual`, `z2m`, `ha-discovery`), set by importers |
| `availability`              | —                    | `{topic, online, offline}` (phase 1 wires it to `reachable`)                   |
| `endpoints`                 | required             | at least one; phase 0 builds the first only                                    |

### Endpoints

| Key           | Default  | Meaning                                                                          |
| ------------- | -------- | -------------------------------------------------------------------------------- |
| `id`          | `main`   | the endpoint within the device                                                   |
| `deviceTypes` | required | matter.js device type names; this build knows `OnOffPlugInUnit` and `OnOffLight` |
| `features`    | —        | cluster features (phase 1)                                                       |
| `bindings`    | `[]`     | see below                                                                        |
| `options`     | —        | family options (phase 1)                                                         |

### Bindings

A binding joins one Matter attribute (`Cluster.attribute` in matter.js' names, e.g. `OnOff.onOff`) with
MQTT in two independent halves; one may be absent.

**`status`** (device → Matter): the payload on `topic` becomes the attribute value.

| Key       | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `topic`   | the topic to subscribe (no wildcards yet)                                                                              |
| `extract` | a JSON path into the payload: `$.POWER`, `state.on`, `$.a[0].b`; absent = the whole payload                            |
| `map`     | extracted value (as text) → attribute value, e.g. `{"ON": true, "OFF": false}`; unmapped values are ignored and logged |
| `type`    | without a map: `boolean`, `number` or `string` — explicit, no guessing (`"ON"` is not a boolean)                       |

Without `extract`, `map` and `type` a plain payload is taken as text and a JSON scalar as itself.

**`command`** (Matter → device): a value a controller wrote becomes a payload on `topic`.

| Key          | Default  | Meaning                                                                                                |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `topic`      | required | the topic to publish to                                                                                |
| `format`     | —        | attribute value (as text) → payload, e.g. `{"true": "ON", "false": "OFF"}`; absent = the value as text |
| `retain`     | `false`  |                                                                                                        |
| `qos`        | `0`      |                                                                                                        |
| `optimistic` | see →    | apply the value locally right after publishing; default `true` without a status half, `false` with one |

Without `optimistic` and with a status half, the controller sees the change when the device reports it.
