# Changelog

## Unreleased

- zigbee2mqtt fans with numbered speeds (IKEA STARKVIND: `fan_mode` `1` … `9`) no longer log "not in the map" for
  every report: the fan mode reads each speed as its third (`Low`, `Medium`, `High`), the same thirds a
  controller's mode writes, so the mode also follows the speed instead of keeping the last named one. **An
  adopted fan is listed as `updated` on the Adopt page**; adopting it again takes the new mapping and keeps the
  user's own edits.

- A stop by SIGTERM or SIGINT (`systemctl stop`, a deploy, Ctrl-C) closes the bridges' Matter storage before the
  process exits: matter.js' own signal handler no longer races the orderly stop, which found the nodes already
  closing and exited with their storage open ("Storage … was not closed before process exit"), risking writes in
  flight such as fabrics and endpoint numbers. A stop that hangs is cut off after 20 seconds.

- The pairing code no longer changes at every start of a bridge that is not commissioned yet: passcode and
  discriminator are generated once per bridge and kept in `commissioning.json` in the storage directory, so a
  code or QR code noted down stays valid across restarts, updates and deploys. Configured values still win. An
  existing installation gets its code fixed at the first start of this version.

- Controllers see the bridge's real version: BasicInformation carries the package version as `softwareVersion`
  (major·1 000 000 + minor·1 000 + patch) and `softwareVersionString`, hardware version 1, and a product label
  without the vendor name; the bridged devices' BridgedDeviceBasicInformation the same (a model that starts with
  the vendor's name loses it in the label). matter.js no longer warns about development values at start.

- Restart and update from the UI (Configuration → Version), under the service `--install` sets up: the restart
  exits with code 75, on which the unit restarts the service; the update checks npm for a newer `mqtt2matter`
  ("not published" until it is there) and hands the version to a root oneshot (`mqtt2matter-update.path` →
  `mqtt2matter-update.service`, `mqtt2matter --apply-update`) that installs it globally with npm, logs for the UI
  and restarts the service — no sudo rule, no polkit. `deploy.sh` runs `--install` again on a host that has the
  service, so the units follow the version. **Run `mqtt2matter --install` once on an existing installation** (or
  deploy with `deploy.sh`) to get the new units.

- Scenes: zigbee2mqtt's scenes on devices and groups and Home Assistant discovery's `scene` entities become
  momentary outlets — one child endpoint per scene whose "on" recalls it and that falls back to off a second
  later (`options.onOff.momentary`, usable for any stateless trigger). Every controller can show and automate an
  outlet, and Alexa can "turn on" it by voice; Matter's own Scenes Management cluster is not used, because its
  scenes are stored by each controller per fabric, and none of the common controllers (Apple Home, Google Home,
  Alexa, Home Assistant) is known to offer them for a bridged device. A zigbee2mqtt group of thermostats or other members is adopted for its
  scenes alone.

- A login for the UI and the API, `server.auth`: `password` (one password, kept as an scrypt hash; a session cookie)
  or `proxy` (a reverse proxy such as nginx with authentik sets the user in a header, `X-Remote-User` by default,
  with an optional logout URL). The event stream is covered too. The mode is set on the Configuration page and
  applies at once; `mqtt2matter --hash-password` prints a hash for the file. **The default stays `none`**: an
  existing installation keeps working without a login.

- One Zigbee device is no longer adopted twice by accident, natively from zigbee2mqtt and a second time through
  zigbee2mqtt's Home Assistant discovery: the discovery entry is reported as a duplicate (`covered`) of the
  native description, and a zigbee2mqtt device whose discovery twin was adopted first is a duplicate of that
  twin. Adopting a duplicate takes an explicit confirmation — in the API too (`force`), not only on the Adopt
  page — and the native side can replace its twin, which is then disabled and kept until it is deleted. The
  twin is also recognised without zigbee2mqtt's `origin` (older versions) and by a Zigbee address among a
  device's connections.

- The join of a Matter attribute, command or event with MQTT is called a **mapping** (German "Zuordnung"), no
  longer a binding — Matter's own Binding cluster means device-to-device control, which mqtt2matter does not
  configure. The configuration field `bindings` of an endpoint became `mappings`, the UI's binding editor the
  mapping editor. A file that still has `bindings` is read as `mappings` with a warning, and written in the new
  form at the next save from the UI.

- Phase 4, the Home Assistant MQTT discovery importer: everything under `homeassistant/#` — the per-entity
  form and the device-based form with components, the 289 abbreviations, `~`, availability lists and modes,
  removal by an empty payload — becomes a device of the manual model on the Adopt page (`importers.ha`): one
  Matter device per Home Assistant device, the primary entity on its own endpoint, the other entities as
  tagged child endpoints, a battery as the power source, event entities and device triggers as buttons; the
  component table of `docs/importers.md` (switch as an outlet, the three light schemas, covers with position
  and tilt, climate, lock, fan, valve, binary sensors and sensors by device class with unit conversions);
  `number`, `select`, `text`, `button`, `scene`, settings and diagnostics listed as unmapped rather than
  dropped. Templates go through the payload engine when it can run them; the importer checks each one and
  leaves the half out — listed with the template — where it cannot (`states()`, `now()`, `int(base=16)`,
  integer dictionary keys, macros). A `suggested_area` is shown on the Adopt page and becomes a Common Area
  tag on the device when the name matches (English or German). A device zigbee2mqtt announces itself is marked
  native; "Adopt all new" leaves it to the zigbee2mqtt importer. The re-sync, orphaning and adopt logic is
  shared by both importers; a conflict now reports the device as updated even when the user's value stays.
  Corpus: the maintainer's ESPHome devices, zigbee2mqtt's discovery and his adapters' device-based payloads
  (anonymised), Tasmota, Shelly, Z-Wave JS UI and OpenMQTTGateway written after their documentation.
- Running as a service: `mqtt2matter --install` sets up `mqtt2matter.service` (a system user of its own, the
  configuration in `/etc/mqtt2matter/mqtt2matter.json`, the Matter storage in `/var/lib/mqtt2matter`),
  `--uninstall` removes it and keeps both; `deploy.sh` (`npm run deploy -- <host>`) tests, builds, packs and
  installs a checkout on a host over ssh and restarts the service. The README lists what the host's network
  needs for Matter.
- Status messages that arrive back to back on one topic are applied in order: a message whose attributes
  were still being set could be overtaken by the next one, and the older value stayed.
- Phase 3, the web UI and its server: `server.port` (8282) serves a Svelte 5 app and the REST + WebSocket
  API of `docs/api.md` — devices (list with source, reachability, bridge and endpoint number; created by hand
  from a device type with its mandatory clusters suggested, duplicated, enabled, deleted; saved and rebuilt
  without a restart, the endpoint number stays), the mapping editor (attribute picker from the Matter data
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
  exposes to device types and mappings per zigbee2mqtt endpoint (child endpoints with number tags), `action`
  enums to GenericSwitch buttons, battery to a power source, availability, groups as the union of their
  members; a re-sync regenerates the baseline and carries the user's edits over (keyed by endpoint and
  mapping target), reports conflicts instead of resolving them, and marks devices that left zigbee2mqtt as
  orphaned without removing them. The same functions (`discover`, `diff`, `adopt`, `orphaned`) are the API
  for the UI; `docs/importers.md` describes the mapping and the API. Test corpus: matterbridge-zigbee2mqtt's
  35-device mock (Apache-2.0, see NOTICE).
- Phase 1, the manual model complete: every device type matter.js ships (plus `PowerSource`), several per
  endpoint, child endpoints, cluster features and attribute defaults from the Matter data model — no table of
  device types; mappings for attributes, commands (`invoke`) and the switch event channel; the payload engine
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
