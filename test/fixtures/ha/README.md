# Home Assistant MQTT discovery corpus

Each file is a list of `{topic, payload}` messages as a broker would hold them retained under
`homeassistant/#`; `test/ha-generate.test.ts` feeds them to the importer. A payload is the JSON object
the publisher sent, or a string for the non-JSON topics that live under the same prefix.

| File                   | Source                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esphome.json`         | ESPHome devices (2023.11 and 2025.5) captured from the maintainer's broker: the per-entity form with abbreviated keys, `device.identifiers` as a string, `suggested_area`, no `origin`. Device names, hostnames, MAC addresses and areas replaced; `configuration_url` removed. |
| `meter-digitizer.json` | Two AI-on-the-edge meter digitizers (v15 and v16), captured: `~`, `payload_available`, identifiers with a slash, a `button`, a `problem` binary sensor with a template, `volume_flow_rate`. Hostnames replaced, `configuration_url` removed.                                    |
| `zigbee2mqtt.json`     | zigbee2mqtt 2.9.2's own discovery for five of the maintainer's devices, captured: a json-schema light, a position-aware cover, a fan with templates, a remote's device triggers, a group with a scene. IEEE addresses and names replaced.                                            |
| `device-based.json`    | The device-based form (`homeassistant/device/…` with `cmps`) as the maintainer's own MQTT adapters (cul2mqtt, fritz2mqtt, govee2mqtt, nut2mqtt, unifi2mqtt, ecoflow2mqtt) and AWTRIX NG publish it, captured. Identifiers, serial numbers and names replaced.                     |
| `misc.json`            | Captured noise under the prefix: binary sensors without a device class (a camera's motion and online sensors), `homeassistant/status`, a state message on a `…/state` topic.                                                                                                                                              |
| `tasmota.json`         | Written by hand in the shape Tasmota's `SetOption19` discovery documents (light with dimmer, CT and RGB; relays; native device triggers; a shutter). Nothing copied.                                                                                                                 |
| `shelly.json`          | Written by hand: Gen2 devices as community scripts announce them (`~`, JSON status), a Gen1 relay and a Gen1 H&T with `expire_after`, a Plus i4 as an `event` entity. Nothing copied.                                                                                                |
| `zwave-js-ui.json`     | Written by hand in the shape Z-Wave JS UI's discovery documents: `value_json.value` everywhere, numeric payloads, a dimmer with scale 99, a lock, a thermostat with dictionary templates. Nothing copied.                                                                           |
| `openmqttgateway.json` | Written by hand in the shape OpenMQTTGateway's BLE and RF discovery documents: `is_defined`, `expire_after`, JSON command payloads. Nothing copied.                                                                                                                                  |

The captured files are the maintainer's own data, anonymised; the hand-written ones follow the public
documentation of the projects named and contain no code or text of theirs.
