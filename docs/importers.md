# Importers

An importer turns a foreign description into ordinary `devices` entries of the manual model
([config.md](config.md)) with `source: {kind, key, version, raw}`, so the user can edit the result like any
other device. The imported **baseline** and the user's **edits** are kept apart: on a re-sync the baseline is
regenerated from the new description, the edits are reapplied, and an edit on a path the new baseline changed
too is a **conflict** — reported, never silently resolved (the edit wins; the report says what the importer
would have written). A device whose description disappears is marked **orphaned** (`source.orphaned: true`) and
never removed by the importer; removal is the user's click.

Importers depend on `model/` and `mqtt/` only ([architecture.md](architecture.md)); the runtime does not know
where a device came from. They are plain functions over a `devices` record as it stands in the file (no
defaults filled in: `DeviceInput`, `DevicesInput` from `model/schema.ts`), so the command line and the server
for the UI call the same code. The report (`diff`), the adoption (`adopt`), the re-sync, orphaning and
restoring are one generic implementation (`src/importers/sync.ts`); an importer brings its discovery, its
`source.raw` format and the generator that turns a raw description into a baseline.

## Baseline + patch (`src/importers/patch.ts`)

Generic, nothing in it knows zigbee2mqtt. A device is diffed as a **keyed tree**: endpoints by their id
(`main` for the first), mappings by their target (`attribute:OnOff.onOff`, `invoke:WindowCovering.stopMotion`,
`event:Switch`; a repeated target gets `#2`, `#3`), everything else by its key; `source` is left out. The
user's edits are `diffTrees(toTree(oldBaseline), toTree(current))`: sets of changed or added leaves and
subtrees, deletes of removed ones. `applyOps(edits, oldBaseline, newBaseline)` reapplies them:

| The edit            | The new baseline at that path | Result                                          |
| ------------------- | ----------------------------- | ----------------------------------------------- |
| set                 | unchanged                     | applied                                         |
| set                 | changed too                   | applied, **conflict** (`user`, `before`, `now`) |
| set below something | that no longer exists         | not applied, **conflict** (`applied: false`)    |
| delete              | anything                      | stays deleted (what the user removed is theirs) |

`resync(oldBaseline, current, newBaseline)` does the whole round and returns the device, the edits and the
conflicts; endpoints and mappings keep the new baseline's order, the user's additions follow.

## Zigbee2MQTT (`src/importers/z2m/`)

Reads the retained `<base>/bridge/devices` and `<base>/bridge/groups` (zigbee2mqtt 1.x and 2.x). Keys:
`z2m:<ieee address>` for devices, `z2m:group:<id>` for groups. Topics are zigbee2mqtt's: `<base>/<friendly
name>` (state), `…/set`, `…/get`, `…/availability`.

### What becomes what

Per zigbee2mqtt endpoint (`''` = the device itself, `l1` … = child endpoints with that id) the exposes decide
the device types and mappings of one Matter endpoint; the device's own endpoint comes first, the children after
it, and a child that shares its device type with a sibling carries a number tag in its Descriptor (`features:
{Descriptor: ["TagList"]}`, `attributes.Descriptor.tagList`) as Matter's disambiguation rule asks. `access`
bits decide the halves: 1 → status, 2 → command, 4 → one `get` per endpoint on its first gettable feature.

| Expose                                                                                | Device type, mappings                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `light`                                                                               | `OnOffLight` / `DimmableLight` / `ColorTemperatureLight` / `ExtendedColorLight` (xy or hs); `OnOff.onOff` (`state`), `LevelControl.currentLevel` (`brightness`, identity 1–254), `ColorControl.colorTemperatureMireds` (`color_temp`, its range → `options.light.minMireds/maxMireds`), `ColorControl.colorXy` on `color` (hs becomes the `HueSaturation` feature; hs alone → `colorHs`), `ColorControl.colorMode` from `color_mode` when colour and colour temperature meet; `coalesce: 50` |
| `switch`                                                                              | `OnOffPlugInUnit`, `OnOff.onOff`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cover`                                                                               | `WindowCovering`; `position` → `currentPositionLiftPercent100ths` (status) / `targetPositionLiftPercent100ths` (command), both `scale {from: [0,100], to: [10000,0]}` (zigbee2mqtt counts 100 = open); `tilt` likewise; `state` → `stopMotion` (`STOP`), and for a cover without `position` also `upOrOpen` / `downOrClose` plus `motion` from `state`; a `moving` / `motor_state` enum → `motion`; IKEA E1757/E1926 get `options.cover.echoFilter`                                          |
| `lock` (state `state`)                                                                | `DoorLock.lockState` from `lock_state` (else `state`), command `LOCK` / `UNLOCK`; a `child_lock` is no lock                                                                                                                                                                                                                                                                                                                                                                                  |
| `climate`                                                                             | `Thermostat`: `localTemperature`, `occupiedHeatingSetpoint` / `occupiedCoolingSetpoint` (`current_…` or `occupied_…`, their limits → `options.climate`), `systemMode` by name, `thermostatRunningState`; `coalesce: 50`                                                                                                                                                                                                                                                                      |
| `fan`                                                                                 | `Fan`: `state` → `OnOff.onOff`; `mode` by name → `FanControl.fanMode`; numeric modes (`1` … `n`) → `percentSetting` through the mode with a template back; `speed` → `percentSetting` scaled                                                                                                                                                                                                                                                                                                 |
| `temperature`, `humidity`, `pressure`                                                 | `TemperatureSensor` (°C / °F), `HumiditySensor`, `PressureSensor` (hPa, kPa)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `illuminance_lux`, `illuminance` (lx)                                                 | `LightSensor` (once per endpoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `battery`, `voltage` (mV/V), `battery_low`                                            | `PowerSource` on the device's endpoint: `batPercentRemaining`, `batVoltage`, `batChargeLevel`                                                                                                                                                                                                                                                                                                                                                                                                |
| `co2`, `co`, `voc` (ppb/ppm), `pm1/25/10`, `formaldehyde` (ppb/ppm), `air_quality`    | `AirQualitySensor` with the concentration clusters and `AirQuality.airQuality`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `contact`, `occupancy` / `presence`, `water_leak`, `rain`, `smoke`, `carbon_monoxide` | `ContactSensor`, `OccupancySensor`, `WaterLeakDetector`, `RainSensor`, `SmokeCoAlarm` (`smokeState` / `coState`)                                                                                                                                                                                                                                                                                                                                                                             |
| `action`                                                                              | one `GenericSwitch` per button: `single`/`double`/`hold`/`release` (one button), `single_l1` (a button per suffix), `brightness_up_click` (per prefix), bare names (`on`, `off`, `open`, `shake`, `tap` …) as single-press buttons; moves, steps, stops, scene recalls, rotations are left out; `options.switch.multiPressMax` from the kinds                                                                                                                                                |

Everything else (`linkquality`, `power`/`energy`/`current` — electrical measurement comes later —, settings,
diagnostics, VOC in µg/m³, soil moisture, vibration as a state) is listed under `unmapped` so the UI can show
it. Every device gets `availability: {topic: "<base>/<name>/availability", template}` for both of
zigbee2mqtt's payload forms. The device's `name` is the friendly name (cut to 32 characters), `vendor` and
`model` the definition's, `serial` the IEEE address.

**Groups** become one endpoint with the union of the members' features: a light group when any member is a
light (brightness, colour temperature range, xy, hs from all), a switch group, or a cover group when every
member is a cover; empty groups, and groups of other members without scenes, are unsupported. Groups have no
`/get` and no availability.

**Scenes** stored on a device (`endpoints.<n>.scenes`) or a group (`scenes`) become one child endpoint each,
`scene_<id>`: an `OnOffPlugInUnit` with `options.onOff.momentary: 1000` whose on publishes
`{"scene_recall": <id>}` to the set topic and falls back to off a second later; children sharing the type carry
the scene's name as their tag label. A group of other members (thermostats) is adopted for its scenes alone.
Matter's own Scenes Management cluster is not used: its scenes are stored by a controller per fabric, and none
of the common controllers is known to offer them for a bridged device.

### `source`

```json
"source": {"kind": "z2m", "key": "0x00158d000945f2b1", "version": "1.3f2c…", "raw": {"kind": "device", "base_topic": "zigbee2mqtt", "ieee_address": "…", "friendly_name": "…", "type": "EndDevice", "power_source": "Battery", "definition": {"vendor": "…", "model": "…", "exposes": [ … ]}}}
```

`raw` is the description trimmed to what regenerates the baseline (a group's `raw` carries the computed
union instead of the members' descriptions); `version` is `<generator version>.<hash of raw>`. A device
without a usable `raw` is kept as it is on a re-sync and only its `source` refreshed.

### The API (`src/importers/z2m/sync.ts`, `source.ts`)

```ts
import {z2m} from 'mqtt2matter';           // src/importers/index.ts

const source = new z2m.Z2mSource('zigbee2mqtt');   // .topics to subscribe; .handle(topic, payload); .load(cache)
const discovery = source.discover();               // or z2m.discover({devices, groups, baseTopic})
//   Discovery {baseTopic, items: Discovered[], sawDevices, sawGroups}
//   Discovered {key, kind: 'device'|'group', name, vendor?, model?, description?, supported, reason?, baseline?, unmapped}

const report = z2m.diff(discovery, config.devices);        // SyncEntry[]: what adopting would do, nothing touched
const {devices, report} = z2m.adopt(config.devices, discovery, {keys?, resync?, orphan?});
//   SyncEntry {key, kind, name, status, device?, conflicts: Conflict[], edits, unmapped, notes}
//   status: 'new' | 'unchanged' | 'updated' | 'orphaned' | 'restored' | 'invalid' | 'unsupported' | 'covered'
//   covered?: the key that covers a `covered` entry; twins?: configured devices for the same physical device
// adopt(devices, discovery, {keys?, resync?, orphan?, force?, replace?}) — `force` takes the covered ones in `keys`
z2m.orphaned(devices);                                      // the keys marked orphaned
z2m.edits(device);                                          // the user's edits against the baseline
z2m.generate(raw);                                          // the baseline for a stored `source.raw`
```

`adopt` keeps the record's order, re-syncs every `z2m` device (`resync: false` keeps them as they are), adds
the selected new keys (default: every supported one), marks the missing ones orphaned (`orphan: false` does
not) and restores an orphaned one that is back. A merge that does not validate against the schema leaves the
device as it was (`invalid`, with the messages in `notes`). Groups are evaluable only together with the devices
payload; without it they count as not seen. Manual devices are never touched.

The server runs `adopt` on every retained `bridge/devices` / `bridge/groups` it receives and shows the
report in the Adopt view; the command line does the same without the UI:

```sh
mqtt2matter --import-z2m [config.json] [--base-topic zigbee2mqtt] [--dry-run] [--no-groups] [--timeout 15]
```

It connects to the broker of the configuration (file and environment), reads the two retained topics, adopts
everything supported that is not in the file yet, re-syncs the rest, writes the file back (other keys
untouched) and prints one line per device plus the static validation; `--dry-run` prints without writing.
Run it again after pairing, renaming or removing devices in zigbee2mqtt; the normal start afterwards logs the
pairing code.

## Home Assistant MQTT discovery (`src/importers/ha/`)

Reads every retained `<prefix>/<component>/[<node_id>/]<object_id>/config` (the per-entity form) and
`<prefix>/device/[<node_id>/]<object_id>/config` (the device-based form with `components`, each with a
`platform`), prefix `homeassistant` by default. The 289 abbreviations of Home Assistant's `abbreviations.py`
(`stat_t`, `cmd_t`, `val_tpl`, `dev`, `cmps`, …) are expanded once, `~` is substituted at the start or end of
every `*_topic`, a component inherits the shared fields of a device-based payload (`device`, `origin`,
`availability`, `state_topic`, `command_topic`, …), and an empty retained payload removes the entity (a
component reduced to its `platform` is removed too). Topics with more than two levels between component and
`config` are no discovery topics — Home Assistant ignores them as well.

Keys: `ha:<first identifier or connection>` of the `device` block, cleaned to the key alphabet and hashed
when longer than 64 characters. **One Matter device per Home Assistant device**: the primary entity (a
`light`, `cover`, `climate`, `lock`, `fan`, `valve`, else a `switch`, in that order) is the node's own
endpoint, every other entity a child endpoint named after its object id; children sharing a device type with
a sibling carry a number tag as the zigbee2mqtt importer's do. An entity without a `device` block is listed as
unsupported (Home Assistant itself needs `device` and `unique_id` to group entities). A `suggested_area`
travels in the report (`area`) and, when the name matches one of Matter's Common Area tags (English, or
German through a synonym table — `Küche`, `Wohnzimmer`, `Bad`, …), becomes a `Descriptor` tag of namespace
`0x10` on the device's own endpoint.

### One device, two descriptions

zigbee2mqtt describes its devices natively and, with its Home Assistant integration on, a second time through
discovery; adopting both would put the same device twice on the bridge. A discovered HA device is reported
with `native: "z2m:<ieee>"` (or `z2m:group:<id>`) when its identifiers are zigbee2mqtt's own
(`zigbee2mqtt_<ieee>`, `zigbee2mqtt_<n>_<group id>` — with or without `origin`, which older versions do not
send), or when a Zigbee IEEE address is among its connections (`["zigbee", …]`, `["ieee", …]`) or its
identifiers (`0x…`). The shared sync makes it a rule for both importers, the API and the command line alike:

- an HA entry with a native key is `covered` (by that key): the native description is preferred;
- a zigbee2mqtt entry whose HA twin is already adopted (and neither disabled nor orphaned) is `covered` by the
  twin, `twins: [<ha key>]`;
- `adopt` never takes a `covered` entry, not even when it is named in `keys`, unless the call says `force`;
  with `replace` as well, the twins are disabled (`enabled: false`) — kept in the file, removed by a click;
- an adopted device whose twin is adopted too is reported with `twins` and a note.

### What becomes what

| Component (keys)                                                                                                                                                                          | Device type, mappings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switch` (`state_on/off`, `payload_on/off`, `value_template`, `command_template`)                                                                                                         | `OnOffPlugInUnit` (the user switches it to `OnOffLight` / `OnOffMountedSwitch` in the editor); `OnOff.onOff` with `map` / `format`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `light`, default schema (`brightness_*`, `brightness_scale`, `color_temp_*`, `color_temp_kelvin`, `min/max_mireds`, `hs_*`, `xy_*`, `rgb_*`, `on_command_type`, `color_mode_state_topic`) | `OnOffLight` / `DimmableLight` / `ColorTemperatureLight` / `ExtendedColorLight` by the topics present; brightness `scale [1, brightness_scale] → [1, 254]`; colour temperature in mireds or `unit: kelvin`; `colorHs` / `colorXy` / `colorRgb` as `h,s` / `x,y` / `r,g,b` text with the command templates `{{ hue }},{{ saturation }}`, `{{ x }},{{ y }}`, `{{ red }},{{ green }},{{ blue }}` unless the config has its own; `options.light.onCommandType`; `colorMode` when colour and colour temperature meet; `rgbw`, `rgbww`, `white`, `effect` listed                                                                                                                                      |
| `light`, json schema (`supported_color_modes`, `brightness`, one JSON state and command)                                                                                                  | the same types; `extract` / `wrap` on `state`, `brightness`, `color_temp`, `color` (xy as an object both ways; hs and rgb back as `{"state": "ON", "color": {…}}` templates), `color_mode`; `coalesce: 50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `light`, template schema (`command_on/off_template`, `state_template`, `brightness_template`, `color_temp_template`)                                                                      | on/off as `{% if value %}<on>{% else %}<off>{% endif %}`, brightness and colour temperature through the on template; colour through separate templates is listed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cover` (`position_*`, `set_position_*`, `position_open/closed`, `state_*`, `payload_open/close/stop`, `tilt_*`)                                                                          | `WindowCovering`: position `scale [closed, open] → [10000, 0]`; `set_position_template` with `{% set position = open %}` in front so Home Assistant's `position` (100 = open) keeps its meaning; `motion` from the state topic (opening/closing/stopped; open/closed too for a cover without position); `upOrOpen` / `downOrClose` for a cover without `set_position_topic`, `stopMotion` always; tilt likewise with `tilt_closed/opened_value`                                                                                                                                                                                                                                                 |
| `climate` (`modes`, `mode_*`, `temperature_*`, `temperature_low/high_*`, `current_temperature_*`, `action_*`, `min/max_temp`, `temperature_unit`, `current_humidity_*`)                   | `Thermostat`: `localTemperature`, `occupiedHeatingSetpoint` / `occupiedCoolingSetpoint` by the modes (both on one `temperature_*` topic unless low/high topics exist), limits → `options.climate`, `systemMode` by name with `{% set value = … %}` giving a `mode_command_template` Home Assistant's `value`, `thermostatRunningState` from `action_topic`; `current_humidity_topic` → a `HumiditySensor` child; fan, swing, preset modes and target humidity listed; `coalesce: 50`                                                                                                                                                                                                            |
| `lock` (`payload_lock/unlock`, `state_locked/unlocked/jammed`)                                                                                                                            | `DoorLock.lockState` (`Locked`, `Unlocked`, `NotFullyLocked`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fan` (`percentage_*`, `speed_range_max`, `preset_modes`)                                                                                                                                 | `Fan`: `OnOff.onOff`, `percentSetting` `scale [0, speed_range_max] → [0, 100]`, `fanMode` from the preset modes named `off` / `low` / `medium` / `high` / `auto`; oscillation and direction listed; `coalesce: 50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `valve` (`state_open/opening/closed/closing`, `payload_open/close`)                                                                                                                       | `WaterValve`: `ValveConfigurationAndControl.currentState`, `open` / `close`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `binary_sensor` by `device_class`                                                                                                                                                         | door / window / opening / garage_door → `ContactSensor` (inverted: Home Assistant's on is the open contact); motion / occupancy / presence / moving → `OccupancySensor`; moisture → `WaterLeakDetector`; cold → `WaterFreezeDetector`; smoke, carbon_monoxide → `SmokeCoAlarm`; battery → `PowerSource.batChargeLevel`, battery_charging → `batChargeState` (the `Rechargeable` feature); every other class and no class: listed                                                                                                                                                                                                                                                                |
| `sensor` by `device_class` and `unit_of_measurement`                                                                                                                                      | temperature (°C, °F) → `TemperatureSensor`; humidity → `HumiditySensor`; pressure / atmospheric_pressure (hPa, mbar, kPa, Pa, bar, psi, inHg, mmHg) → `PressureSensor`; illuminance (lx) → `LightSensor`; battery (%) → `PowerSource.batPercentRemaining`; carbon_dioxide, carbon_monoxide (ppm), pm1 / pm25 / pm10 (µg/m³), volatile_organic_compounds(_parts), nitrogen_dioxide, ozone, formaldehyde (ppb; ppm × 1000) → `AirQualitySensor`; aqi → `AirQuality.airQuality` through the US bands; volume_flow_rate (m³/h) → `FlowSensor`; °C / °F / lx without a class count as temperature / illuminance; everything else listed (the electrical classes until electrical measurement exists) |
| `event` (`event_types`, payload `{"event_type": …}`)                                                                                                                                      | one `GenericSwitch` per button the event types name (`single` / `double` / `long` / `single_push` / `double_press` …, the shared press-kind table), `extract: event_type` unless a `value_template` renders it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `device_trigger` / `device_automation` (`topic`, `type`, `subtype`, `payload`)                                                                                                            | accumulated per device: one button per `subtype` (Tasmota's `button_1`), the kind from the `type` (`button_short_press`, `button_double_press`, `button_long_press`, …) or, for zigbee2mqtt's `type: action`, from the subtype as the zigbee2mqtt importer reads actions; continuous actions listed                                                                                                                                                                                                                                                                                                                                                                                             |
| `scene` (`command_topic`, `payload_on`)                                                                                                                                                   | a child `OnOffPlugInUnit` with `options.onOff.momentary: 1000`: on publishes `payload_on` (default `ON`), off nothing; tagged with the scene's name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `button`, `number`, `select`, `text`, `update`, `device_tracker`, `notify`, `image`, …                                                                                                    | listed as unmapped (a Matter button emits events), never dropped silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Entities with an `entity_category` (`config`, `diagnostic`) or `enabled_by_default: false` are listed, not
mapped — settings and metrics are not the device's function — except battery sensors, which Matter has a place
for. Every status half of an entity with `expire_after` gets `expire`; `optimistic: true` and `retain: true`
are carried into the command half. The device's availability is the primary entity's (`availability_topic`
with `payload_available` / `payload_not_available`, or the `availability` list with `availability_mode`),
else the first entity's that has one. `name`, `vendor`, `model` and `serial` come from the device block,
merged over every entity (each repeats it, often only with its identifiers).

**Templates** go to the payload engine when it can run them: the importer parses every `*_template` with the
same library and checks the filters, tests, functions and free names against what the engine provides
([config.md](config.md), "Templates"; `src/importers/ha/templates.ts`). A template it cannot run — `states()`,
`now()`, `this`, the time and regex helpers, `int(base=16)`, a dictionary with integer keys, macros — leaves
that half of the mapping out and is listed under `unmapped` with the template text, so the user sees what to
write by hand. Where Home Assistant's command template sees a value the engine names differently, a `{% set …
%}` prelude gives it Home Assistant's meaning: `value` is `ON` / `OFF` (`payload_on` / `payload_off`) for a
switch, the mode string for a climate or a fan, `LOCK` / `UNLOCK` for a lock; `position` and `tilt_position`
are the open-percentage for a cover. A `value_template` on a `light` is read as its `state_value_template`
(what Tasmota sends).

### `source`

```json
"source": {"kind": "ha-discovery", "key": "aa0000000002", "version": "1.9f0c…", "raw": {"kind": "ha", "prefix": "homeassistant", "identity": "aa0000000002", "device": {"identifiers": "aa0000000002", "name": "…", "manufacturer": "Espressif", "model": "esp01_1m", "suggested_area": "Küche"}, "entities": [{"id": "relay", "topic": "homeassistant/switch/usb-relay-02/relay/config", "component": "switch", "config": { … }}]}}
```

`raw` holds the expanded configs trimmed of what the generator does not read (`icon`, `entity_picture`,
`json_attributes_*`, `configuration_url`, …), in a stable order; `version` is `<generator version>.<hash of raw>`.

### The API (`src/importers/ha/sync.ts`, `source.ts`)

```ts
import {ha} from 'mqtt2matter';

const source = new ha.HaSource('homeassistant');     // .topics = ['homeassistant/#']; .handle(topic, payload); .load(cache)
const discovery = source.discover();                 // or ha.discover({entities, prefix, seen})
//   Discovery {prefix, items: Discovered[], seen}
//   Discovered {key, kind: 'device', name, vendor?, model?, area?, native?, supported, reason?, baseline?, unmapped}

const report = ha.diff(discovery, config.devices);   // SyncEntry[] as the zigbee2mqtt importer's, plus `area` and `native`
const {devices, report} = ha.adopt(config.devices, discovery, {keys?, resync?, orphan?});
ha.orphaned(devices);
ha.edits(device);
ha.generate(raw);
ha.checkTemplate(source, 'status' | 'command');     // {ok} | {ok: false, reason}
ha.areaTag('Wohnzimmer');                            // {name: 'LivingRoom', id: 52} | undefined
```

`seen` is true once any discovery message (or removal) was handled: before that nothing is orphaned. The
server subscribes `<prefix>/#` when `importers.ha.enabled` is set ([config.md](config.md)), feeds the
importer every message and shows the report on the Adopt page; a re-sync regenerates the baseline from the
retained configs and carries the user's edits over like the zigbee2mqtt importer does. There is no command
line for it; the UI is the way to adopt.
