# Changelog

## Unreleased

- Phase 3, the web UI and its server: `server.port` (8282) serves a Svelte 5 app and the REST + WebSocket
  API of `docs/api.md` — devices (list with source, reachability, bridge and endpoint number; created by hand
  from a device type with its mandatory clusters suggested, duplicated, enabled, deleted; saved and rebuilt
  without a restart, the endpoint number stays), the binding editor (attribute picker from the Matter data
  model, topic picker from the live topic tree with JSON keys as paths, every step of both halves with a live
  preview in both directions, test-publish), presets, adopt (the zigbee2mqtt importer's report: new,
  updated, restored, orphaned, invalid, unsupported; conflicts and unmapped exposes; re-sync; orphans are
  removed only by a click), bridges (QR code and manual pairing code, fabrics, the commissioning window), the
  live MQTT view with a publish form, the log, the strict dry run as a page and per device, import/export and
  the settings. German and English, light and dark, the look of the maintainer's other UIs (tokens and
  controls copied, no dependency). `importers.z2m` makes the bridge watch zigbee2mqtt's bridge topics while it
  runs. The UI has no login: keep it on a trusted network or behind a reverse proxy.
- Phase 2, the Zigbee2MQTT importer: `mqtt2matter --import-z2m` reads the retained `bridge/devices` and
  `bridge/groups` and writes every supported device and group into the configuration as ordinary devices —
  exposes to device types and bindings per zigbee2mqtt endpoint (child endpoints with number tags), `action`
  enums to GenericSwitch buttons, battery to a power source, availability, groups as the union of their
  members; a re-sync regenerates the baseline and carries the user's edits over (keyed by endpoint and
  binding target), reports conflicts instead of resolving them, and marks devices that left zigbee2mqtt as
  orphaned without removing them. The same functions (`discover`, `diff`, `adopt`, `orphaned`) are the API
  for the UI; `docs/importers.md` describes the mapping and the API. Test corpus: matterbridge-zigbee2mqtt's
  35-device mock (Apache-2.0, see NOTICE).
- Phase 1, the manual model complete: every device type matter.js ships (plus `PowerSource`), several per
  endpoint, child endpoints, cluster features and attribute defaults from the Matter data model — no table of
  device types; bindings for attributes, commands (`invoke`) and the switch event channel; the payload engine
  in both directions (extract, Jinja templates through `@huggingface/jinja` with Home Assistant's filters,
  map, explicit types, units, scale, offset, invert, round, wrap, format, fixed payloads, `coalesce` per
  endpoint, `get` at start, `expire`, a `codec` escape hatch); the families — light (level with on-command
  ordering, colour temperature, xy, hue/saturation, RGB-only devices, colour mode arbitration), cover (the
  position state machine with report timeout, external moves, echo filter; state-only covers; tilt), climate,
  lock, fan, switch events, power source, availability (`all`/`any`/`latest`) → reachable; static validation
  against the model and the strict dry run `mqtt2matter --check`; the preset format. `docs/config.md` is the
  frozen schema.
- Phase 0, the skeleton: configuration file and environment, the MQTT connection with a topic cache, a
  Matter bridge (matter.js 0.18) with stable endpoint ids and a shard map prepared for several bridges, the
  first payload steps (extract, type, map, format) and the `OnOff` family — one `OnOffPlugInUnit` or
  `OnOffLight` bound to a status/command topic pair works end to end.
