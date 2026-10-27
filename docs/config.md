# Configuration

A JSON file — `mqtt2matter [config.json]`, else `$MQTT2MATTER_CONFIG`, else `./mqtt2matter.json` — with
the environment on top. Every object is strict: an unknown key is an error. Every field has a default; an
empty file (or none) starts a bridge on port 5540 with no devices. `example/mqtt2matter.json` is a complete
example; `mqtt2matter --check [config.json]` validates a file against the Matter data model and matter.js
in strict mode without touching the network.

**This schema is frozen** (format 1): importers write it, the UI edits it, and a later version that has to
change it migrates files on load. Additions are allowed; renames and removals are not. The one rename so far,
before the first release: an endpoint's `bindings` are `mappings` (Matter's own Binding cluster means
something else); a file with `bindings` is read as `mappings`, a warning is logged once at start, and the file is
written in the new form at the next save from the UI (`POST /api/import` takes the old form too).

## Environment

| Variable                            | Overrides                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `MQTT2MATTER_CONFIG`                | the file path                                                                 |
| `MQTT2MATTER_MQTT_URL`              | `mqtt.url`                                                                    |
| `MQTT2MATTER_MQTT_USERNAME`         | `mqtt.username`                                                               |
| `MQTT2MATTER_MQTT_PASSWORD`         | `mqtt.password`                                                               |
| `MQTT2MATTER_MQTT_CLIENT_ID`        | `mqtt.clientId`                                                               |
| `MQTT2MATTER_STORAGE`               | `storage`                                                                     |
| `MQTT2MATTER_LOG_LEVEL`             | `log.level`                                                                   |
| `MQTT2MATTER_MATTER_LOG_LEVEL`      | `log.matter`                                                                  |
| `MQTT2MATTER_SERVER_HOST`           | `server.host`                                                                 |
| `MQTT2MATTER_SERVER_PORT`           | `server.port`                                                                 |
| `MQTT2MATTER_AUTH`                  | `server.auth.mode`                                                            |
| `MQTT2MATTER_AUTH_PASSWORD`         | `server.auth.password` (a hash, or the plain password: it is hashed at start) |
| `MQTT2MATTER_AUTH_PROXY_HEADER`     | `server.auth.proxyHeader`                                                     |
| `MQTT2MATTER_AUTH_PROXY_LOGOUT_URL` | `server.auth.proxyLogoutUrl`                                                  |

## Top level

| Key                                               | Default                 | Meaning                                                                                                         |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `mqtt.url`                                        | `mqtt://localhost:1883` | `mqtt://`, `mqtts://`, `ws://`, `wss://` as mqtt.js takes it                                                    |
| `mqtt.username`, `mqtt.password`, `mqtt.clientId` | —                       | credentials; a random client id when unset                                                                      |
| `storage`                                         | `./data`                | matter.js storage (fabrics, endpoint numbers), `shards.json` and `commissioning.json`                           |
| `log.level`                                       | `info`                  | `debug`, `info`, `warn`, `error`                                                                                |
| `log.matter`                                      | `warn`                  | matter.js' own log level                                                                                        |
| `vendorId`                                        | `0xFFF1`                | the Matter test vendor id                                                                                       |
| `productId`                                       | `0x8000`                | bridge n gets `productId + n`                                                                                   |
| `bridges`                                         | `{"default": {}}`       | one entry per Matter bridge, see below; at least one                                                            |
| `devices`                                         | `{}`                    | one entry per device, keyed by the **device key**                                                               |
| `server.enabled`                                  | `true`                  | the web UI and its API (`docs/api.md`); `false` for headless                                                    |
| `server.host`, `server.port`                      | `0.0.0.0`, `8282`       | where the UI listens                                                                                            |
| `server.topics`                                   | `["#"]`                 | MQTT subscriptions for the UI's topic tree and live view, on top of the mappings' topics                        |
| `server.auth.mode`                                | `none`                  | who may use the UI and the API: `none` (everyone who reaches the port), `password`, `proxy` — see below         |
| `server.auth.password`                            | —                       | `password` mode: the password's hash (`mqtt2matter --hash-password`, or set on the UI's Configuration page)     |
| `server.auth.proxyHeader`                         | `X-Remote-User`         | `proxy` mode: the header the reverse proxy sets to the authenticated user                                       |
| `server.auth.proxyLogoutUrl`                      | —                       | `proxy` mode: where the UI's "Log out" goes (the proxy's sign-out)                                              |
| `server.auth.sessionHours`                        | `168`                   | `password` mode: how long a login lasts                                                                         |
| `presets`                                         | `[]`                    | directories with the user's preset files (`*.json`), on top of the shipped ones                                 |
| `importers.z2m.enabled`                           | `true`                  | watch zigbee2mqtt's `bridge/devices` and `bridge/groups` for the UI's adopt page ([importers.md](importers.md)) |
| `importers.z2m.baseTopic`                         | `zigbee2mqtt`           | zigbee2mqtt's base topic                                                                                        |
| `importers.ha.enabled`                            | `true`                  | watch Home Assistant MQTT discovery (`<prefix>/#`) for the UI's adopt page ([importers.md](importers.md))       |
| `importers.ha.prefix`                             | `homeassistant`         | the discovery prefix                                                                                            |

## Access

**The default is `none`: no login.** Whoever reaches `server.port` can edit the devices, publish to the broker
and open commissioning windows — keep the port on a trusted network, or choose a mode:

- `password`: one password. The UI shows a login; a login is a session cookie (HttpOnly, SameSite=Strict, `Secure`
  behind a proxy that sends `X-Forwarded-Proto: https`) that lasts `sessionHours` or until the logout or the next
  start. The file holds an scrypt hash, written by the UI's Configuration page (Access) or printed by
  `mqtt2matter --hash-password` (it reads the password from stdin); a plain password in the file or in
  `MQTT2MATTER_AUTH_PASSWORD` works too and is hashed at start. Ten failed logins from one address within
  15 minutes are refused for the rest of that window.
- `proxy`: a reverse proxy (nginx with authentik, Authelia, oauth2-proxy, …) authenticates and sets
  `proxyHeader` to the user; a request without it is refused, the user is shown in the UI. **Only the proxy may
  reach the port** — set `server.host` to `127.0.0.1` (or firewall the port) — or anyone can send the header.
  The UI switches to proxy mode only through a request that already carries the header.

The Configuration page's Access section changes the mode at once, without a restart; the other settings apply at
the next start. A mode the environment sets is not editable there.

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
`A–Z a–z 0–9 _ -`. Pairing codes are logged at start while the bridge is not commissioned. A passcode or
discriminator that is not configured is generated at the bridge's first start and kept in
`<storage>/commissioning.json`, so the pairing code stays the same across restarts; delete the bridge's entry
there for a new one.

## Devices

```json
"living-room-lamp": {
  "name": "Living room lamp", "vendor": "Tasmota", "model": "Sonoff B1",
  "availability": {"topic": "tele/b1/LWT", "online": "Online", "offline": "Offline"},
  "endpoints": [{
    "deviceTypes": ["ColorTemperatureLight"],
    "options": {"light": {"onCommandType": "last"}},
    "mappings": [
      {"attribute": "OnOff.onOff",
       "status":  {"topic": "stat/b1/RESULT", "extract": "$.POWER", "map": {"ON": true, "OFF": false}},
       "command": {"topic": "cmnd/b1/POWER", "format": {"true": "ON", "false": "OFF"}}},
      {"attribute": "LevelControl.currentLevel",
       "status":  {"topic": "stat/b1/RESULT", "extract": "$.Dimmer", "unit": "percentLevel"},
       "command": {"topic": "cmnd/b1/Dimmer", "unit": "percentLevel", "round": 0}},
      {"attribute": "ColorControl.colorTemperatureMireds",
       "status":  {"topic": "stat/b1/RESULT", "extract": "$.CT"},
       "command": {"topic": "cmnd/b1/CT"}}
    ]
  }]
}
```

The **device key** (`living-room-lamp`) is the Matter endpoint id: 1–64 characters of `A–Z a–z 0–9 : . _ -`.
It keeps the device's endpoint number stable; rename through `name`, never through the key.

| Key                         | Default              | Meaning                                                                                                                                                      |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                      | required             | the label controllers show (≤ 32)                                                                                                                            |
| `vendor`, `model`, `serial` | —                    | `BridgedDeviceBasicInformation`; the serial defaults to the key                                                                                              |
| `enabled`                   | `true`               | a disabled device is not built                                                                                                                               |
| `bridge`                    | assigned             | the bridge id; default: assigned once and remembered in `shards.json`                                                                                        |
| `source`                    | `{"kind": "manual"}` | where the device came from: `manual`, `z2m`, `ha-discovery`, `preset`; `key`, `version`, `raw`, `orphaned` are the importer's ([importers.md](importers.md)) |
| `availability`              | —                    | one availability topic (short form) or `{topics: [...], mode}` → `reachable`, see below                                                                      |
| `endpoints`                 | required             | at least one; the first is the bridged node, the others are its child endpoints (ids `<key>~<id>`)                                                           |

### Availability

```json
"availability": {"topic": "zigbee2mqtt/lamp/availability", "extract": "state", "online": "online", "offline": "offline"}
"availability": {"mode": "all", "topics": [{"topic": "tele/a/LWT", "online": "Online", "offline": "Offline"}, {"topic": "tele/b/LWT", "online": "Online", "offline": "Offline"}]}
```

| Key                 | Default   | Meaning                                                                          |
| ------------------- | --------- | -------------------------------------------------------------------------------- |
| `topics[].topic`    | required  | the topic                                                                        |
| `topics[].extract`  | —         | a JSON path into the payload                                                     |
| `topics[].template` | —         | a Jinja template over `value` and `value_json`, like a status half's             |
| `topics[].online`   | `online`  | the payload (after extract/template) that means reachable                        |
| `topics[].offline`  | `offline` | the payload that means unreachable; other payloads are ignored                   |
| `mode`              | `latest`  | `all`: every topic online; `any`: one online; `latest`: the last message decides |

`reachable` on the bridged device follows availability and every `expire` of the device's status halves: a
device is unreachable when availability says so or any expired topic has not reported in time.

### Endpoints

| Key           | Default  | Meaning                                                                                              |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | `main`   | the endpoint within the device; unique per device                                                    |
| `deviceTypes` | required | matter.js device type names; the first is the endpoint's type, the others are added (`PowerSource`)  |
| `features`    | —        | cluster features on top of what the device types require, e.g. `{"PowerSource": ["Battery"]}`        |
| `attributes`  | —        | fixed attribute values and defaults, e.g. `{"PowerSource": {"description": "2×AA"}}`                 |
| `mappings`    | `[]`     | see below                                                                                            |
| `options`     | defaults | the family options (light, cover, climate, fan, switch, powerSource), see below                      |
| `coalesce`    | `0`      | ms: JSON command payloads to one topic within this window are merged into one message (z2m's `/set`) |

**Device types** are matter.js' names: every `*Device` it ships (`OnOffLight`, `DimmableLight`,
`ColorTemperatureLight`, `ExtendedColorLight`, `OnOffPlugInUnit`, `DimmablePlugInUnit`, `WindowCovering`,
`Thermostat`, `DoorLock`, `Fan`, `GenericSwitch`, `ContactSensor`, `OccupancySensor`, `TemperatureSensor`,
`HumiditySensor`, `LightSensor`, `PressureSensor`, `FlowSensor`, `AirQualitySensor`, `WaterLeakDetector`,
`RainSensor`, `SmokeCoAlarm`, …) plus the utility `PowerSource`. The device type's mandatory clusters come
with it, its optional clusters and any other cluster are added when a mapping names them. Feature names are
matter.js' (`Lighting`, `ColorTemperature`, `HueSaturation`, `Xy`, `PositionAwareLift`, `Heating`, `Battery`,
…) or the specification's codes (`LT`, `CT`, `HS`, `XY`, `PA_LF`, `HEAT`, `BAT`). The families add the
features their mappings imply (a bound `occupiedHeatingSetpoint` → `Heating`; `colorHs` → `HueSaturation`).

### Mappings

A mapping joins one Matter attribute, command or event channel with MQTT in two independent halves —
`status` (device → Matter) and `command` (Matter → device); one may be absent.

| Key         | Meaning                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `attribute` | `Cluster.attribute` in matter.js' names: `OnOff.onOff`, `LevelControl.currentLevel`, `Thermostat.systemMode`                             |
| `invoke`    | a command that is not an attribute write: `WindowCovering.stopMotion`, `WindowCovering.upOrOpen`, `Identify.identify`; command half only |
| `event`     | a family's event channel: `Switch` — the status half yields a press kind, see _Switch_                                                   |
| `comment`   | free text                                                                                                                                |

Enum attributes are written by their member names in `map`, `default` and `format` (`"Heat"`, `"Locked"`,
`"Good"`; case does not matter); bitmap attributes by their field names, comma-separated (`"heat,fan"`,
`""` for none), or by a boolean for the first field (`OccupancySensing.occupancy`). Values a controller can
write — thermostat setpoints and `systemMode`, `FanControl.fanMode` and `percentSetting`, `WindowCovering.mode`
— are applied by matter.js before they are published, so their command halves are optimistic in any case.

**`status`** (device → Matter), in this order:

| Key        | Meaning                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic`    | the topic to subscribe                                                                                                                                                                                                                          |
| `extract`  | a JSON path into the payload: `$.POWER`, `state.on`, `$.a[0].b`; absent = the whole payload                                                                                                                                                     |
| `template` | a Jinja template over `value` (the extracted value or the payload text), `value_json` (the parsed payload) and `topic`; its text is the value; an empty result is ignored, `None` (Home Assistant's "no value") is `null` unless `map` names it |
| `map`      | value (as text) → attribute value: `{"ON": true, "OFF": false}`, `{"heat": "Heat"}`; an unmapped value is ignored unless `default` is set; `null` clears a nullable attribute                                                                   |
| `default`  | the value for an unmapped key or a failed `type` (`null` as in `map`)                                                                                                                                                                           |
| `type`     | without a map: `boolean`, `number` or `string` — explicit, no guessing (`"ON"` is not a boolean)                                                                                                                                                |
| `unit`     | a named conversion into the attribute's unit, see _Units_                                                                                                                                                                                       |
| `scale`    | `{"from": [0, 100], "to": [1, 254], "clamp": true}`: linear, clamped into `from`; reversed `to` bounds invert (`[10000, 0]`)                                                                                                                    |
| `offset`   | added after scaling                                                                                                                                                                                                                             |
| `invert`   | booleans: not; numbers with a scale: mirrored within `scale.to`                                                                                                                                                                                 |
| `round`    | decimals; integer attributes are rounded to whole numbers in any case                                                                                                                                                                           |
| `expire`   | seconds without a message on this topic after which the device is unreachable                                                                                                                                                                   |
| `get`      | `{"topic", "payload"}` published at start and after a reconnect so the device reports (z2m `…/get`)                                                                                                                                             |
| `codec`    | `{"module": "./my-codec.js", "options": …}`: `decode(payload, {topic, options})` replaces every step above                                                                                                                                      |

Without `extract`, `map` and `type` a plain payload is taken as text and a JSON scalar as itself; a JSON
object or array is handed to the family (the colour composites).

A message that carries no value for a mapping — the `extract` path is missing, the template renders nothing,
the value is `null` for an attribute that cannot be null — is skipped and logged at debug: several mappings
often share a topic and each message carries only some of their values. Other failures are warnings.

**`command`** (Matter → device): a value a controller wrote becomes a payload on `topic`.

| Key                                          | Default  | Meaning                                                                                                                                                                  |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `topic`                                      | required | the topic to publish to                                                                                                                                                  |
| `unit`, `scale`, `offset`, `invert`, `round` | —        | the status steps inverted                                                                                                                                                |
| `precision`                                  | —        | decimals the number is printed with                                                                                                                                      |
| `format`                                     | —        | attribute value (as text, enum name, bitmap field list) → payload: `{"true": "ON", "false": "OFF"}`, `{"Locked": "LOCK"}`                                                |
| `payload`                                    | —        | a fixed payload (for `invoke` mappings: `"STOP"`)                                                                                                                        |
| `template`                                   | —        | a Jinja template over `value`, `name` (an enum's member name), `topic` and the family's fields, see _Templates_                                                          |
| `wrap`                                       | —        | a JSON path: the payload becomes `{"a": {"b": value}}` for `$.a.b`; merged by `coalesce`                                                                                 |
| `retain`                                     | `false`  |                                                                                                                                                                          |
| `qos`                                        | `0`      |                                                                                                                                                                          |
| `optimistic`                                 | see →    | apply the value locally right after publishing; default `true` without a status half (or a related one: a cover's target is confirmed by its position), `false` with one |
| `codec`                                      | —        | `encode(value, {topic, options, fields})` returns the payload (a string) or JSON                                                                                         |

Without `format`, `payload` and `template` the payload is the value as text (an object as JSON).

### Units

| `unit`          | Device  | Matter attribute                               |
| --------------- | ------- | ---------------------------------------------- |
| `celsius`       | °C      | 0.01 °C (`TemperatureMeasurement`, setpoints)  |
| `fahrenheit`    | °F      | 0.01 °C                                        |
| `kelvin`        | K       | mireds (`colorTemperatureMireds`)              |
| `percent100ths` | 0–100 % | 0–10000 (humidity, cover positions)            |
| `halfPercent`   | 0–100 % | 0–200 (`batPercentRemaining`)                  |
| `percentLevel`  | 0–100 % | level 1–254, 0 stays 0 (`currentLevel`)        |
| `byteLevel`     | 0–255   | level 1–254 (brightness as z2m and HA send it) |
| `lux`           | lux     | `IlluminanceMeasurement`: 10000·log10(lux) + 1 |
| `volt`          | V       | mV (`batVoltage`)                              |
| `degrees254`    | 0–360°  | hue 0–254                                      |
| `percent254`    | 0–100 % | saturation 0–254                               |
| `seconds10ths`  | s       | tenths of a second                             |

### Templates

Jinja through `@huggingface/jinja`, Home Assistant style. Available: expressions, `if … else …`, loops, the
filters `int` (Home Assistant's `int(default, base)`: `'ff' | int(0, 16)`), `float`, `string`, `bool`, `lower`, `upper`, `trim`, `abs`, `default`, `length`, `join`,
`replace`, `tojson`, `round(precision, method, default)`, `is_defined`, `iif`, `multiply`, `is_number`, `max`,
`min`; the tests `defined`, `none`, `number`, `string`; the functions `iif`, `float`, `int`, `max`, `min`.
Whole floats render as Python does (`3.0`). Not available: `states()`, `now()`, macros, `format`.

Status templates see `value`, `value_json`, `topic`. Command templates see `value`, `topic`, `name` (an
enum member's name) and the family's fields: lights add `level`, `brightness` (0–254), `percent`,
`transition` (seconds, when the controller gave one); colours add `hue` (0–360), `saturation` (0–100), `x`,
`y`, `red`, `green`, `blue` (and `h`, `s`, `r`, `g`, `b`), colour temperature `mireds`, `kelvin`; covers add
`position`, `percent` (0–100, 0 = open as Matter has it), `open` (100 − position), `percent100ths`; fans
`percent`, `mode`, `speed`; locks `action` (`locked`, `unlocked`, `unlatched`).

### Composite attributes

The light family owns three attribute names beyond the model; each value is an object (status: also an
array or `"a,b(,c)"`):

| Attribute               | Fields                                       | Feature it implies                             |
| ----------------------- | -------------------------------------------- | ---------------------------------------------- |
| `ColorControl.colorHs`  | `hue` 0–360, `saturation` 0–100 (`h`, `s`)   | `HueSaturation`                                |
| `ColorControl.colorXy`  | `x`, `y` 0–1                                 | `Xy`                                           |
| `ColorControl.colorRgb` | `r`, `g`, `b` 0–255 (`red`, `green`, `blue`) | — (converted to the features the endpoint has) |

A controller's colour command goes to whichever of these the endpoint binds (converted), else to the plain
`currentHue`/`currentSaturation` or `currentX`/`currentY` mappings. A status on any colour attribute sets every
representation the endpoint's features carry and `colorMode`/`enhancedColorMode` — unless `ColorControl.colorMode`
has a status mapping of its own (bind it for devices that report `color_mode`; a message carrying both a colour and
a colour temperature lets the last mapping win otherwise).

The cover family owns `WindowCovering.motion`: `opening`, `closing`, `stopped` (`stop`, `idle`), `open`,
`closed` — for state-only covers and for `moving`/`motor_state` reports.

### Families and their options

**onOff** (`OnOff`)

| Option      | Default | Meaning                                                                                                                                                                              |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `momentary` | `0`     | ms; a stateless trigger (a scene, a button behind an outlet): on publishes the command and the endpoint falls back to off after this long, off publishes nothing; `0` = plain on/off |

**light** (`OnOff`, `LevelControl`, `ColorControl`)

| Option                   | Default      | Meaning                                                                                                              |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `onCommandType`          | `last`       | HA's `on_command_type`: `first` publishes on, then the level; `last` the level, then on; `brightness` only the level |
| `transition`             | `true`       | pass the controller's transition time to the templates as `transition`                                               |
| `minMireds`, `maxMireds` | `153`, `500` | the colour temperature range                                                                                         |

A controller's `moveToLevelWithOnOff` publishes the level and, per `onCommandType`, the on/off; `move` and
`step` publish the resulting level. Values are applied locally only where the mapping is optimistic.

**cover** (`WindowCovering`): bind `currentPositionLiftPercent100ths` (status) and `targetPositionLiftPercent100ths`
(command) for a position-aware cover — Matter counts 0 = open, 100 % = closed; a device counting the other way
uses `scale: {"from": [0, 100], "to": [10000, 0]}` — or `motion` plus `invoke` mappings for `upOrOpen`,
`downOrClose`, `stopMotion` for a state-only one; tilt uses the `…Tilt…` attributes.

| Option          | Default | Meaning                                                                                                              |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `echoFilter`    | `false` | hold back a first report after a command that repeats the old position until a second report or the timeout (FYRTUR) |
| `reportTimeout` | `30`    | seconds after the last report before a movement counts as ended (target snaps to current)                            |
| `tolerance`     | `100`   | percent100ths within which current and target count as equal                                                         |

A command sets the target and publishes it; reports drive the current position; `operationalStatus` follows
from target vs current; a report while no command is in flight is an external move whose predicted target (the
direction's extreme) is written before the current position; after a stop the next report is the final
position.

**climate** (`Thermostat`): temperatures in Matter's 0.01 °C (`unit: celsius`). Features follow the mappings:
`Heating` with `occupiedHeatingSetpoint`, `Cooling` with `occupiedCoolingSetpoint`, `AutoMode` with both and
`systemMode`. `thermostatRunningState` is a bitmap (`"heat"`, `"cool"`, `"fan"`, `""`).

| Option                                     | Default               | Meaning                               |
| ------------------------------------------ | --------------------- | ------------------------------------- |
| `minHeat`, `maxHeat`, `minCool`, `maxCool` | `7`, `30`, `16`, `32` | setpoint limits in °C                 |
| `deadband`                                 | `2`                   | °C between the setpoints in auto mode |

**lock** (`DoorLock`): `lockState` with the names `Locked`, `Unlocked`, `NotFullyLocked` (jammed), `Unlatched`;
a controller's lock/unlock publishes the command half keyed by those names and waits for the report.

**fan** (`FanControl`): bind `percentSetting` (command) and `percentCurrent` or `percentSetting` (status), or
`fanMode` by name (`Off`, `Low`, `Medium`, `High`, `Auto`); the family keeps mode and percent consistent. `Auto`
needs the `Auto` feature (`"features": {"FanControl": ["Auto"]}`); in Auto Matter has no percent setting, so map
the device's auto value to `null` on `percentSetting` (`"map": {"auto": null, …}`). A percent report while the mode
is Auto leaves Auto.

| Option          | Default    | Meaning                                                              |
| --------------- | ---------- | -------------------------------------------------------------------- |
| `low`, `medium` | `33`, `66` | percent thresholds between the modes                                 |
| `speedMax`      | `0`        | discrete speeds (the `MultiSpeed` feature, `speedSetting`); 0 = none |

**switch** (`GenericSwitch`, the `Switch` event channel): the status half's value is a press kind —
`single` (`click`), `double`, `triple`, a number of presses, `long` (`hold`), `press`, `release`,
`longRelease` — played into the switch's events (initialPress, shortRelease, multiPressOngoing/Complete,
longPress, longRelease) with the delays below; one `GenericSwitch` endpoint per button. A latching switch takes
the value as its position.

| Option              | Default     | Meaning                                               |
| ------------------- | ----------- | ----------------------------------------------------- |
| `kind`              | `momentary` | `momentary` or `latching`                             |
| `numberOfPositions` | `2`         |                                                       |
| `multiPressMax`     | `3`         | presses in one sequence                               |
| `multiPressDelay`   | `300`       | ms after a release before a sequence completes        |
| `longPressDelay`    | `500`       | ms a press lasts before it is long                    |
| `pressDuration`     | `50`        | ms between the press and the release the family plays |

**powerSource** (`PowerSource` on the same endpoint): `batPercentRemaining` (`unit: halfPercent`),
`batVoltage` (`unit: volt`), `batChargeLevel` (`Ok`, `Warning`, `Critical`); `Battery` is the default feature,
`Wired` when `wiredCurrentType` is bound.

| Option                | Default    | Meaning                                                             |
| --------------------- | ---------- | ------------------------------------------------------------------- |
| `warning`, `critical` | `20`, `10` | percent at or below which the charge level is derived, unless bound |

**sensors** have no options: `TemperatureMeasurement`, `RelativeHumidityMeasurement`, `IlluminanceMeasurement`,
`PressureMeasurement`, `FlowMeasurement` (`measuredValue`), `BooleanState.stateValue` (contact, leak, rain,
freeze), `OccupancySensing.occupancy` (a boolean), `AirQuality.airQuality` (`Good` … `ExtremelyPoor`), the
concentration clusters' `measuredValue` (CO₂ and CO in ppm, NO₂, O₃, formaldehyde and VOC in ppb, PM1/2.5/10 in
µg/m³, radon in Bq/m³).

## Presets

A preset is a device template in a JSON file:

```json
{
  "id": "tasmota/relay",
  "name": "Tasmota relay",
  "vendor": "Tasmota",
  "format": 1,
  "variables": {
    "topic": {"label": "Tasmota topic"},
    "name": {"label": "Name", "default": "Relay"}
  },
  "device": {
    "name": "%name%",
    "vendor": "Tasmota",
    "availability": {"topic": "tele/%topic%/LWT", "online": "Online", "offline": "Offline"},
    "endpoints": [
      {
        "deviceTypes": ["OnOffPlugInUnit"],
        "mappings": [
          {
            "attribute": "OnOff.onOff",
            "status": {"topic": "stat/%topic%/RESULT", "extract": "$.POWER", "map": {"ON": true, "OFF": false}},
            "command": {"topic": "cmnd/%topic%/POWER", "format": {"true": "ON", "false": "OFF"}}
          }
        ]
      }
    ]
  }
}
```

`%name%` placeholders stand anywhere in `device`; every one must be declared in `variables` (`label`,
`description`, `default`, `optional`). Applying a preset substitutes the values into the JSON text and
validates the result; the device gets `source: {"kind": "preset", "key": "<id>"}`. Users add their own files
(`presets` in the top level); an id that is taken already (a shipped one) is reported and skipped.

### Shipped presets

The UI's device editor offers them; `POST /api/presets/:id/apply` ([api.md](api.md)) does the same. Every
preset has a `name` variable (what controllers show) besides the ones listed here.

**mqtt-smarthome** — adapters that follow the [mqtt-smarthome convention](https://github.com/mqtt-smarthome/mqtt-smarthome/blob/master/SPEC.md)
(2.0): `<instance>/status/<item>` as a plain value or a `{val, ts, lc}` object (both are read),
`<instance>/set/<item>` with a plain value, `<instance>/connected` `2` = reachable (`0` and `1` unreachable).
Variables: `instance` (the adapter's `--name`), `item` (the item path, may have several levels).

| Id                           | Matter            | Notes                                                                                                             |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mqtt-smarthome/switch`      | OnOffPlugInUnit   | `true`/`false` (also `1`/`0`, `on`/`off`, `yes`/`no`); sends `true`/`false`                                       |
| `mqtt-smarthome/light`       | OnOffLight        | the same as a light                                                                                               |
| `mqtt-smarthome/dimmer`      | DimmableLight     | `max`: the value for 100 % (default `100`; `1` for 0…1 levels); on/off follows the level, off sends `0`, on `max` |
| `mqtt-smarthome/cover`       | WindowCovering    | `max` as above; the item counts 0 = closed … `max` = open; stop is not sent                                       |
| `mqtt-smarthome/contact`     | ContactSensor     | `true`, `1`, `open` = open                                                                                        |
| `mqtt-smarthome/occupancy`   | OccupancySensor   | `true`/`false`                                                                                                    |
| `mqtt-smarthome/temperature` | TemperatureSensor | °C                                                                                                                |
| `mqtt-smarthome/humidity`    | HumiditySensor    | %                                                                                                                 |
| `mqtt-smarthome/button`      | GenericSwitch     | `true`, `1`, `single`, `short`, `click` = one press; `double`, `triple`; `long`, `hold` = a long press            |

**WLED** — `topic`: the device topic (Config → Sync Interfaces → MQTT → Device Topic; default `wled/<MAC>`),
the whole of it. WLED publishes `<topic>/g` (brightness 0–255) and `<topic>/c` (`#RRGGBB`, `#WWRRGGBB` with
white) on every change and keeps `<topic>/status` (`online`/`offline`) retained; there is no request for the
state, so after a restart of mqtt2matter the light shows its state from the next change on (or at once where the
broker holds `/g` and `/c` retained).

| Id            | Matter             | Notes                                                                                                                                                                                                         |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wled/light`  | ExtendedColorLight | brightness to `<topic>` (`ON`/`OFF`/0–255), the colour to `<topic>/col` as a decimal `0xRRGGBB`; colour temperature as `{"seg":{"cct":<K>}}` to `<topic>/api` (strips with white channels; not reported back) |
| `wled/dimmer` | DimmableLight      | single-colour strips: on/off and brightness only                                                                                                                                                              |

**Shelly Gen2/Gen3** (Plus, Pro, Gen3, Gen4) — `prefix`: the MQTT prefix (Settings → MQTT; by default the device
id, `shellyplus1pm-a8032abe54dc`). **Switch on "Generic status update"** (`status_ntf`) in the device's MQTT
settings: the presets read the complete component status from `<prefix>/status/<component>:<id>`, which the
device publishes only with it. Commands go as RPC frames to `<prefix>/rpc` (`src` `mqtt2matter`, so the answers
land on `mqtt2matter/rpc`); at start each status is requested with `status_update` on
`<prefix>/command/<component>:<id>` (MQTT control, firmware 0.14 and later; 1.6 for lights). Availability is
`<prefix>/online` (`true`/`false`). `channel` is the component id: `0`, or `1` for the second relay of a 2PM.

| Id                      | Matter                            | Notes                                                                                                               |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `shelly-gen2/switch`    | OnOffPlugInUnit                   | `switch:<channel>` `output`; `Switch.Set`                                                                           |
| `shelly-gen2/switch-pm` | OnOffPlugInUnit, ElectricalSensor | as above plus `apower`, `voltage`, `current` → active power, voltage, current (1PM, 2PM, Plug S, Pro xPM)           |
| `shelly-gen2/cover`     | WindowCovering                    | `cover:<channel>` `current_pos` (100 = open); `Cover.GoToPosition`, `Open`, `Close`, `Stop`; calibrate first        |
| `shelly-gen2/dimmer`    | DimmableLight                     | `light:<channel>` `output`, `brightness`; `Light.Set` (a level switches on)                                         |
| `shelly-gen2/ht`        | TemperatureSensor, PowerSource    | Plus H&T: `temperature:0`, `devicepower:0` battery; humidity (`humidity:0`) as a child; no availability (it sleeps) |
| `shelly-gen2/i4`        | GenericSwitch ×4                  | Plus i4: `NotifyEvent` on `<prefix>/events/rpc`, single/double/triple/long push per input; inputs of type Button    |

One preset is one channel: a 2PM's two relays are two devices (`channel` `0` and `1`) — the preset format has no
repetition, and two devices let each relay have its own name and room.

**Shelly Gen1** (the first generation, topics under `shellies/`) — `device`: the id in the device's topics,
`<model>-<deviceid>` (`shelly1pm-B929CC`). At start each mains-powered preset sends `update` to
`shellies/<device>/command`, which makes the device publish its state; availability is `shellies/<device>/online`.
Battery devices sleep between reports and have no availability.

| Id                        | Matter                            | Notes                                                                                                                         |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `shelly-gen1/relay`       | OnOffPlugInUnit                   | `relay/<channel>` (`on`/`off`/`overpower`) and `relay/<channel>/command`                                                      |
| `shelly-gen1/relay-pm`    | OnOffPlugInUnit, ElectricalSensor | as above plus the active power from `relay/<channel>/power` (1PM, 2.5, Plug S)                                                |
| `shelly-gen1/roller`      | WindowCovering                    | Shelly 2.5 in roller mode: `roller/0/pos` (100 = open, `-1` uncalibrated is skipped), `roller/0/command/pos`, open/close/stop |
| `shelly-gen1/dimmer`      | DimmableLight                     | Dimmer 1/2: `light/0/status` (`ison`, `brightness`), JSON to `light/0/set`                                                    |
| `shelly-gen1/ht`          | TemperatureSensor, PowerSource    | H&T: `sensor/temperature` (set the device to °C), `sensor/battery`; humidity as a child                                       |
| `shelly-gen1/door-window` | ContactSensor, PowerSource        | Door/Window 1/2: `sensor/state` `open`/`close`, `sensor/battery`; `sensor/lux` as a child                                     |

**Tasmota** — `topic`: the device's MQTT topic (Configuration → MQTT → Topic); the default FullTopic
`%prefix%/%topic%/`.

| Id              | Matter          | Notes                                                       |
| --------------- | --------------- | ----------------------------------------------------------- |
| `tasmota/relay` | OnOffPlugInUnit | `POWER` from `stat/<topic>/RESULT`, availability from `LWT` |
