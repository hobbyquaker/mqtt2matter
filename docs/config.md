# Configuration

A JSON file — `mqtt2matter [config.json]`, else `$MQTT2MATTER_CONFIG`, else `./mqtt2matter.json` — with
the environment on top. Every object is strict: an unknown key is an error. Every field has a default; an
empty file (or none) starts a bridge on port 5540 with no devices. `example/mqtt2matter.json` is a complete
example; `mqtt2matter --check [config.json]` validates a file against the Matter data model and matter.js
in strict mode without touching the network.

**This schema is frozen** (format 1): importers write it, the UI edits it, and a later version that has to
change it migrates files on load. Additions are allowed; renames and removals are not.

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
"living-room-lamp": {
  "name": "Living room lamp", "vendor": "Tasmota", "model": "Sonoff B1",
  "availability": {"topic": "tele/b1/LWT", "online": "Online", "offline": "Offline"},
  "endpoints": [{
    "deviceTypes": ["ColorTemperatureLight"],
    "options": {"light": {"onCommandType": "last"}},
    "bindings": [
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

| Key                         | Default              | Meaning                                                                                                                       |
| --------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | required             | the label controllers show (≤ 32)                                                                                             |
| `vendor`, `model`, `serial` | —                    | `BridgedDeviceBasicInformation`; the serial defaults to the key                                                               |
| `enabled`                   | `true`               | a disabled device is not built                                                                                                |
| `bridge`                    | assigned             | the bridge id; default: assigned once and remembered in `shards.json`                                                         |
| `source`                    | `{"kind": "manual"}` | where the device came from: `manual`, `z2m`, `ha-discovery`, `preset`; `key`, `version`, `raw`, `orphaned` are the importer's |
| `availability`              | —                    | one availability topic (short form) or `{topics: [...], mode}` → `reachable`, see below                                       |
| `endpoints`                 | required             | at least one; the first is the bridged node, the others are its child endpoints (ids `<key>~<id>`)                            |

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
| `bindings`    | `[]`     | see below                                                                                            |
| `options`     | defaults | the family options (light, cover, climate, fan, switch, powerSource), see below                      |
| `coalesce`    | `0`      | ms: JSON command payloads to one topic within this window are merged into one message (z2m's `/set`) |

**Device types** are matter.js' names: every `*Device` it ships (`OnOffLight`, `DimmableLight`,
`ColorTemperatureLight`, `ExtendedColorLight`, `OnOffPlugInUnit`, `DimmablePlugInUnit`, `WindowCovering`,
`Thermostat`, `DoorLock`, `Fan`, `GenericSwitch`, `ContactSensor`, `OccupancySensor`, `TemperatureSensor`,
`HumiditySensor`, `LightSensor`, `PressureSensor`, `FlowSensor`, `AirQualitySensor`, `WaterLeakDetector`,
`RainSensor`, `SmokeCoAlarm`, …) plus the utility `PowerSource`. The device type's mandatory clusters come
with it, its optional clusters and any other cluster are added when a binding names them. Feature names are
matter.js' (`Lighting`, `ColorTemperature`, `HueSaturation`, `Xy`, `PositionAwareLift`, `Heating`, `Battery`,
…) or the specification's codes (`LT`, `CT`, `HS`, `XY`, `PA_LF`, `HEAT`, `BAT`). The families add the
features their bindings imply (a bound `occupiedHeatingSetpoint` → `Heating`; `colorHs` → `HueSaturation`).

### Bindings

A binding joins one Matter attribute, command or event channel with MQTT in two independent halves —
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

| Key        | Meaning                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic`    | the topic to subscribe                                                                                                                                                    |
| `extract`  | a JSON path into the payload: `$.POWER`, `state.on`, `$.a[0].b`; absent = the whole payload                                                                               |
| `template` | a Jinja template over `value` (the extracted value or the payload text), `value_json` (the parsed payload) and `topic`; its text is the value; an empty result is ignored |
| `map`      | value (as text) → attribute value: `{"ON": true, "OFF": false}`, `{"heat": "Heat"}`; an unmapped value is ignored unless `default` is set                                 |
| `default`  | the value for an unmapped key or a failed `type`                                                                                                                          |
| `type`     | without a map: `boolean`, `number` or `string` — explicit, no guessing (`"ON"` is not a boolean)                                                                          |
| `unit`     | a named conversion into the attribute's unit, see _Units_                                                                                                                 |
| `scale`    | `{"from": [0, 100], "to": [1, 254], "clamp": true}`: linear, clamped into `from`; reversed `to` bounds invert (`[10000, 0]`)                                              |
| `offset`   | added after scaling                                                                                                                                                       |
| `invert`   | booleans: not; numbers with a scale: mirrored within `scale.to`                                                                                                           |
| `round`    | decimals; integer attributes are rounded to whole numbers in any case                                                                                                     |
| `expire`   | seconds without a message on this topic after which the device is unreachable                                                                                             |
| `get`      | `{"topic", "payload"}` published at start and after a reconnect so the device reports (z2m `…/get`)                                                                       |
| `codec`    | `{"module": "./my-codec.js", "options": …}`: `decode(payload, {topic, options})` replaces every step above                                                                |

Without `extract`, `map` and `type` a plain payload is taken as text and a JSON scalar as itself; a JSON
object or array is handed to the family (the colour composites).

**`command`** (Matter → device): a value a controller wrote becomes a payload on `topic`.

| Key                                          | Default  | Meaning                                                                                                                                                                  |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `topic`                                      | required | the topic to publish to                                                                                                                                                  |
| `unit`, `scale`, `offset`, `invert`, `round` | —        | the status steps inverted                                                                                                                                                |
| `precision`                                  | —        | decimals the number is printed with                                                                                                                                      |
| `format`                                     | —        | attribute value (as text, enum name, bitmap field list) → payload: `{"true": "ON", "false": "OFF"}`, `{"Locked": "LOCK"}`                                                |
| `payload`                                    | —        | a fixed payload (for `invoke` bindings: `"STOP"`)                                                                                                                        |
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
filters `int`, `float`, `string`, `bool`, `lower`, `upper`, `trim`, `abs`, `default`, `length`, `join`,
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
`currentHue`/`currentSaturation` or `currentX`/`currentY` bindings. A status on any colour attribute sets every
representation the endpoint's features carry and `colorMode`/`enhancedColorMode` — unless `ColorControl.colorMode`
has a status binding of its own (bind it for devices that report `color_mode`; a message carrying both a colour and
a colour temperature lets the last binding win otherwise).

The cover family owns `WindowCovering.motion`: `opening`, `closing`, `stopped` (`stop`, `idle`), `open`,
`closed` — for state-only covers and for `moving`/`motor_state` reports.

### Families and their options

**light** (`OnOff`, `LevelControl`, `ColorControl`)

| Option                   | Default      | Meaning                                                                                                              |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `onCommandType`          | `last`       | HA's `on_command_type`: `first` publishes on, then the level; `last` the level, then on; `brightness` only the level |
| `transition`             | `true`       | pass the controller's transition time to the templates as `transition`                                               |
| `minMireds`, `maxMireds` | `153`, `500` | the colour temperature range                                                                                         |

A controller's `moveToLevelWithOnOff` publishes the level and, per `onCommandType`, the on/off; `move` and
`step` publish the resulting level. Values are applied locally only where the binding is optimistic.

**cover** (`WindowCovering`): bind `currentPositionLiftPercent100ths` (status) and `targetPositionLiftPercent100ths`
(command) for a position-aware cover — Matter counts 0 = open, 100 % = closed; a device counting the other way
uses `scale: {"from": [0, 100], "to": [10000, 0]}` — or `motion` plus `invoke` bindings for `upOrOpen`,
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

**climate** (`Thermostat`): temperatures in Matter's 0.01 °C (`unit: celsius`). Features follow the bindings:
`Heating` with `occupiedHeatingSetpoint`, `Cooling` with `occupiedCoolingSetpoint`, `AutoMode` with both and
`systemMode`. `thermostatRunningState` is a bitmap (`"heat"`, `"cool"`, `"fan"`, `""`).

| Option                                     | Default               | Meaning                               |
| ------------------------------------------ | --------------------- | ------------------------------------- |
| `minHeat`, `maxHeat`, `minCool`, `maxCool` | `7`, `30`, `16`, `32` | setpoint limits in °C                 |
| `deadband`                                 | `2`                   | °C between the setpoints in auto mode |

**lock** (`DoorLock`): `lockState` with the names `Locked`, `Unlocked`, `NotFullyLocked` (jammed), `Unlatched`;
a controller's lock/unlock publishes the command half keyed by those names and waits for the report.

**fan** (`FanControl`): bind `percentSetting` (command) and `percentCurrent` or `percentSetting` (status), or
`fanMode` by name (`Off`, `Low`, `Medium`, `High`, `Auto`); the family keeps mode and percent consistent.

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
        "bindings": [
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
validates the result; the device gets `source: {"kind": "preset", "key": "<id>"}`. The shipped Tasmota, Shelly
and ESPHome presets come with the first release; users add their own files.
