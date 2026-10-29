# Changelog

## Unreleased

- **A device key or endpoint id with a `.` is refused** with a validation error that names it and says why:
  matter.js uses `.` as the separator of its endpoint id paths and refused such a device when the bridge built
  it. The configuration schema, `POST /api/devices` and `PUT /api/devices/:key`, the UI's key fields and the
  importers agree now: the Home Assistant importer turns a `.` in a device identifier or entity id into `_`, the
  Zigbee2MQTT importer one in an endpoint name. A configuration file with such a key no longer loads — such a
  device never worked, so nothing that ran is lost; rename its key (`a.b` → `a-b`).
- **A Home Assistant binary sensor announced without a `device_class` gets its sensor type chosen on the Adopt
  page.** Some publishers (camera motion sensors from an NVR's MQTT plugin, for one) announce motion as a plain
  on/off binary sensor; the importer listed it as unmapped and a device whose only function it was could not be
  adopted. The details of such an entry now offer a type per sensor — motion / occupancy, contact, water leak,
  frost, smoke, CO, battery low, battery charging — or "not mapped"; the entity is generated as if it had
  announced that class, and the device becomes adoptable. Nothing is guessed from names. The choice is stored in
  the device's `source.raw.classes` and kept across re-syncs; an adopted device can be given a type later
  ("Apply"). Such entries are shown without "show unsupported".
  - **API**: `GET /api/adopt` entries carry `unclassed: [{id, name, class?}]`; `POST /api/adopt/:kind/:key`
    takes `classes: {<entity id>: <class> | null}` (Home Assistant only, `400` for an unknown entity or class).

## 0.3.1

- **Fixed: creating a device from a preset replaced the device created before.** The dialog derived the key from
  the device name, the presets' default names were generic ("Switch"), and `PUT /api/devices/:key` creates or
  replaces — so the second device silently took the first one's place. Now the suggested key is never one a
  device has (`switch`, `switch-2`, `switch-3`, …), a taken key is named and refused in the preset dialog, the
  create dialog and the duplicate prompt, and the UI creates through the new `POST /api/devices` (`{key, device}`,
  `409` when the key exists), which can never replace a device; `PUT` stays for edits.
- **Presets name the device after what identifies it** instead of a generic "Switch", "Relay" or "Light": the
  mqtt-smarthome item with its slashes as spaces (`kitchen/light` → "kitchen light"), the Tasmota topic, the Shelly device id or MQTT prefix, the WLED topic,
  the OpenBeken client, the Valetudo identifier — with the channel or relay index where the preset is one channel
  of a device (`shellyplus2pm-… 1`, `plug-1 2`, `obk-th temperature`). A preset's default may reference other
  variables (`"%item%"`), `%item|words%` with the value's slashes as spaces. In the dialog the name follows those
  fields while you type, until you edit it yourself; a cleared name follows again.
  - **Preset format**: a variable's `default` may reference other variables (`"default": "%topic% %index%"`);
    where no value is given, the references are resolved from the other values and the result trimmed. A
    reference to an undeclared variable or a cycle is a preset problem. An addition: every preset that was valid
    stays valid and yields the same device.

## 0.3.0

- The Presets page has a search box: every word must occur in a preset's name, vendor, id or description
  ("shelly cover", "tasmota sensor"); the toolbar shows how many of the presets match.
- **A new top bar**: on the right, the GitHub link, **§** for the licences, the version, the statistics and a
  gear for the Configuration page (no longer a tab).
  - The **version** is a button with a popup: installed and latest version, "check for updates", "update to
    vX" and the restart (they were the Version section of the Configuration page); a dot on the version says
    an update is published.
  - The **statistics** popup shows uptime, CPU, memory (RSS and heap), event loop utilisation and lag
    (mean/max), devices, endpoints, bridges paired, controllers (fabrics), MQTT topics and MQTT messages per
    second — from the new `GET /api/stats`, averaged over a 5-second window, polled only while the popup is
    open.
  - The **licences** dialog lists mqtt2matter's own licence and NOTICE and the licence of every third-party
    package that ships — the runtime dependencies and what the UI bundle contains, with their licence texts.
    The build generates the list (`ui/dist/licenses.json`) from `node_modules`; nothing is kept by hand.
  - **Language and theme** moved to the top of the Configuration page ("Display"); they are still kept per
    browser.
- **The fabrics on the Bridges page** say which controller each one belongs to — Apple Home, Apple Keychain (the
  companion fabric Apple adds when the bridge is paired from Apple Home, with a hint saying so), Google Home,
  Amazon Alexa, Home Assistant, SmartThings, Aqara, IKEA, Hue and more, by the root vendor id as the CSA's ledger
  lists it — with the fabric's label, index and id, the bridge's and the controller's node ids, the compressed
  fabric id, the active sessions and subscriptions, and the last contact. `GET /api/bridges` carries the new
  fields.

## 0.2.0

- **Presets for the mqtt-smarthome convention**: switch, light, dimmer, cover, contact, occupancy,
  temperature, humidity and button for any adapter that publishes `<name>/status/<item>` (plain values and
  `{val, ts, lc}` alike), takes `<name>/set/<item>` and reports `<name>/connected`.
- **Presets for WLED**: a colour light (brightness, RGB colour, colour temperature to the main segment) and a
  dimmer for single-colour strips, over WLED's own MQTT topics with its `status` topic as availability.
- **Presets for Shelly Gen2/Gen3** (Plus, Pro, Gen3): switch, switch with power metering (an electrical
  sensor with active power, voltage and current), cover, dimmer, Plus H&T and Plus i4 — the component status
  from the "Generic status update" topics, commands as RPC, the status requested at start.
- **Presets for first-generation Shelly devices**: relay, relay with power, roller (2.5), Dimmer 1/2, H&T and
  Door/Window, over the `shellies/<id>/…` topics; mains-powered ones ask for their state at start.
- **More Tasmota presets**: dimmer, CT light, colour light (RGB/RGBW/RGBCCT with the colour mode from the
  channels), shutter, and temperature, temperature/humidity and climate (with pressure) sensors from
  `tele/<topic>/SENSOR`. `tasmota/relay` takes an optional relay index for `POWER1`…`POWERn` and asks for the
  state at start.
- **Robot vacuums**: a `RoboticVacuumCleaner` family — run mode Idle/Cleaning, operational state, pause,
  resume and go home routed to mappings — and a **Valetudo preset** over Valetudo's own MQTT topics with the
  battery. Bridged, it shows in Google Home and Home Assistant; Apple Home and Alexa want a vacuum as a Matter
  node of its own, which mqtt2matter does not offer yet.
- The model knows a derived cluster's own enum values and the commands it takes over from its base
  (`RvcOperationalState`: `Docked`, `SeekingCharger`, `pause`, `resume`), and a rechargeable battery gets its
  mandatory charge state by default.
- **Presets for OpenBeken** (Tuya/BK7231 and similar): relay channel, dimmer, CT and colour light, temperature and
  humidity channels with their divisor.
- Templates: `int` takes Home Assistant's default and base, `'ff' | int(0, 16)` reads hexadecimal.
- A status value that a message does not carry (an extract path that is missing, a template that renders
  nothing) is logged at debug instead of as a warning: topics several mappings share — Tasmota's `RESULT`, a
  partial JSON report — carry only some of the values at a time.
- **Fans with an auto mode** (IKEA STARKVIND through Zigbee2MQTT or Home Assistant discovery): `auto` is
  Matter's Auto fan mode — both importers now set the `Auto` feature, so it is no longer refused — and the
  percent setting is `null` while in auto instead of a warning per message. A status `map` or `default` may be
  `null` for a nullable attribute, a template's `None` is read as `null`, and a `null` for an attribute that
  cannot be null is skipped quietly. Adopted fans show as updated on the next sync.
- Every shipped preset is tested: applied, validated, through the strict dry run, and against an in-process
  broker with its documented status and command messages.

## 0.1.0

The first release: a generic MQTT → Matter bridge on matter.js 0.18.

- **The model.** Devices composed from every device type matter.js ships (plus `PowerSource`), several per
  endpoint, child endpoints, cluster features and attribute defaults from the Matter data model — no
  hand-kept table of device types. A **mapping** joins a Matter attribute, command (`invoke`) or event with
  MQTT: a status half (device → Matter) and a command half (Matter → device). The configuration schema
  (`docs/config.md`) is frozen; later versions migrate files on load.
- **The payload engine**, in both directions: extract (JSON paths), Jinja templates in Home Assistant's dialect
  (through `@huggingface/jinja`, with the Home Assistant filters it lacks added), map, explicit types, units,
  scale, offset, invert, round, wrap, format, fixed payloads, `coalesce` per endpoint, `get` at start,
  `expire`, and a `codec` escape hatch.
- **The families**: light (level with on-command ordering, colour temperature, xy, hue/saturation, RGB-only
  devices, colour mode arbitration), cover (a position state machine with report timeout, external moves and
  an echo filter; state-only covers; tilt), climate, lock, fan, buttons (GenericSwitch events), momentary
  outlets (`options.onOff.momentary`), sensors, power source, availability (`all` / `any` / `latest`) →
  reachable.
- **Validation**: static checks against the Matter data model, and `mqtt2matter --check`, a strict dry run
  that builds every device in a throw-away matter.js node.
- **Zigbee2MQTT importer**: `bridge/devices` and `bridge/groups` become ordinary devices — exposes to device
  types and mappings per endpoint, `action` enums to buttons, battery to a power source, groups as the union
  of their members, scenes as momentary outlets. A re-sync carries your edits over, reports conflicts instead
  of resolving them, and marks devices that left Zigbee2MQTT as orphaned without removing them. From the UI
  or `mqtt2matter --import-z2m`.
- **Home Assistant MQTT discovery importer**: the per-entity and the device-based form, abbreviations, `~`,
  availability modes; one Matter device per Home Assistant device; templates where the engine can run them,
  listed where it cannot; `suggested_area` as a Matter Common Area tag; what has no Matter equivalent is
  listed, not dropped. A device that Zigbee2MQTT also describes natively is a duplicate and adopted once.
- **The web UI** (port 8282): devices, the mapping editor with a live preview of every step and a topic picker
  over the live topic tree, presets, the Adopt page, bridges with QR code, pairing code and fabrics, the live
  MQTT view, the log, the dry run, import/export, settings. English and German, light and dark. A login
  (`server.auth`: a password, or a reverse proxy's user header); **the default is no login** — keep the port
  on a trusted network or set one.
- **Running as a service**: `mqtt2matter --install` sets up a systemd service under a user of its own
  (configuration in `/etc/mqtt2matter`, the Matter storage in `/var/lib/mqtt2matter`), `--uninstall` removes
  it and keeps both. Restart and update from the UI. The pairing code stays the same across restarts.
