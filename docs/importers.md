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
defaults filled in: `DeviceInput`, `DevicesInput` from `model/schema.ts`), so the command line today and the
server for the UI tomorrow call the same code.

## Baseline + patch (`src/importers/patch.ts`)

Generic, nothing in it knows zigbee2mqtt. A device is diffed as a **keyed tree**: endpoints by their id
(`main` for the first), bindings by their target (`attribute:OnOff.onOff`, `invoke:WindowCovering.stopMotion`,
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
conflicts; endpoints and bindings keep the new baseline's order, the user's additions follow.

## Zigbee2MQTT (`src/importers/z2m/`)

Reads the retained `<base>/bridge/devices` and `<base>/bridge/groups` (zigbee2mqtt 1.x and 2.x). Keys:
`z2m:<ieee address>` for devices, `z2m:group:<id>` for groups. Topics are zigbee2mqtt's: `<base>/<friendly
name>` (state), `…/set`, `…/get`, `…/availability`.

### What becomes what

Per zigbee2mqtt endpoint (`''` = the device itself, `l1` … = child endpoints with that id) the exposes decide
the device types and bindings of one Matter endpoint; the device's own endpoint comes first, the children after
it, and a child that shares its device type with a sibling carries a number tag in its Descriptor (`features:
{Descriptor: ["TagList"]}`, `attributes.Descriptor.tagList`) as Matter's disambiguation rule asks. `access`
bits decide the halves: 1 → status, 2 → command, 4 → one `get` per endpoint on its first gettable feature.

| Expose                                                                                | Device type, bindings                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
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
member is a cover; other groups and empty ones are unsupported. Groups have no `/get` and no availability.

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
//   status: 'new' | 'unchanged' | 'updated' | 'orphaned' | 'restored' | 'invalid' | 'unsupported'
z2m.orphaned(devices);                                      // the keys marked orphaned
z2m.edits(device);                                          // the user's edits against the baseline
z2m.generate(raw);                                          // the baseline for a stored `source.raw`
```

`adopt` keeps the record's order, re-syncs every `z2m` device (`resync: false` keeps them as they are), adds
the selected new keys (default: every supported one), marks the missing ones orphaned (`orphan: false` does
not) and restores an orphaned one that is back. A merge that does not validate against the schema leaves the
device as it was (`invalid`, with the messages in `notes`). Groups are evaluable only together with the devices
payload; without it they count as not seen. Manual devices are never touched.

The server (phase 3) runs `adopt` on every retained `bridge/devices` / `bridge/groups` it receives and shows the
report in the Adopt view; until then the command line does it:

```sh
mqtt2matter --import-z2m [config.json] [--base-topic zigbee2mqtt] [--dry-run] [--no-groups] [--timeout 15]
```

It connects to the broker of the configuration (file and environment), reads the two retained topics, adopts
everything supported that is not in the file yet, re-syncs the rest, writes the file back (other keys
untouched) and prints one line per device plus the static validation; `--dry-run` prints without writing.
Run it again after pairing, renaming or removing devices in zigbee2mqtt; the normal start afterwards logs the
pairing code.
