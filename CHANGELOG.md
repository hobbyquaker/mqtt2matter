# Changelog

## Unreleased

- **Presets for the mqtt-smarthome convention**: switch, light, dimmer, cover, contact, occupancy,
  temperature, humidity and button for any adapter that publishes `<name>/status/<item>` (plain values and
  `{val, ts, lc}` alike), takes `<name>/set/<item>` and reports `<name>/connected`.
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
