# Preset fixtures

One file per vendor: for every shipped preset of that vendor the values it is applied with, and the messages
`test/presets.e2e.test.ts` plays — `status` messages a device publishes with the attributes (or switch events)
they must set, `commands` a controller sends with the messages they must publish, `availability` messages with
the reachability they must give. `test/presets.test.ts` checks that every shipped preset has an entry here and
that each applied preset validates and passes the strict dry run.

Every payload is written by hand in the shape the vendor's public documentation gives; nothing is captured from
a real device and nothing is copied from another project.

| File                  | Documentation                                                                          |
| --------------------- | -------------------------------------------------------------------------------------- |
| `mqtt-smarthome.json` | the mqtt-smarthome convention, SPEC 2.0: https://github.com/mqtt-smarthome/mqtt-smarthome/blob/master/SPEC.md |
| `tasmota.json`        | Tasmota's MQTT, command, lights and shutter documentation: https://tasmota.github.io/docs/MQTT/, …/Commands/, …/Lights/, …/Blinds-and-Shutters/; the `Shutter1` JSON shape as forum captures show it (the documentation names the fields, not the frame) |
| `wled.json`           | WLED's MQTT and JSON API: https://kno.wled.ge/interfaces/mqtt/, https://kno.wled.ge/interfaces/json-api/ |
| `shelly-gen2.json`    | Shelly's Gen2+ API: https://shelly-api-docs.shelly.cloud/gen2/ — RPC channels, Mqtt, Switch, Cover, Light, Input, Temperature, Humidity, DevicePower |
| `shelly-gen1.json`    | Shelly's Gen1 API, the MQTT sections: https://shelly-api-docs.shelly.cloud/gen1/ |
