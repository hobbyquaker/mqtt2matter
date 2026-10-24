# The API

The web UI talks to the bridge through this API and nothing else; it is the contract between `ui/` and
`src/server/`. REST under `/api/`, JSON both ways; one WebSocket at `/api/events`. The server listens
on `server.host:server.port` (`0.0.0.0:8282` by default, see [config.md](config.md)) and serves the built
UI for every other path.

**There is no authentication.** The API edits the configuration, publishes to the broker and opens
commissioning windows; keep it on a trusted network or behind a reverse proxy that adds a login.

## Conventions

- A request body is JSON (`content-type: application/json`), at most 8 MB.
- A success is `200` with a JSON body, or `204` without one. An error is `4xx`/`5xx` with
  `{"error": "<message>", "details"?: …}`; a device that does not parse comes back as `400` with
  `details.issues: [{level, path, message}]`, the same shape the validator uses.
- Values matter.js hands out as bigints are strings in JSON; byte arrays are hex.
- A **device** in a request or response is a device entry of [config.md](config.md) — the parsed form
  (every field present, defaults filled) in responses; a request may leave the defaults out. The file is
  written in the compact form (no defaults).
- `:key` is a device key, `:id` a bridge id.

## Status and configuration

| Route             | Answer                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/status` | `{version, uptime (s), running, configPath, mqtt: {url, connected}, bridges: [bridge…], devices: n, importers: ["z2m", …]}`                                                                                                                                                 |
| `GET /api/config` | `{path, settings, overridden, effective}` — `settings` is the file's top level without `devices` (what the editor saves back), `overridden` the paths the environment sets (`["mqtt.url"]`), `effective` the running values with the MQTT password masked                   |
| `PUT /api/config` | body: the `settings` object (`mqtt`, `storage`, `log`, `vendorId`, `productId`, `bridges`, `server`, `presets`); validated as a whole; `409` when a path the environment owns would change; answers `{saved: true, restartNeeded: true}` — settings apply at the next start |

## Devices

| Route                         | Answer                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/devices`            | `[{key, name, enabled, deviceTypes, endpoints: n, source, bridge, number, reachable, built, violations, errors, warnings}]` — `number` is the Matter endpoint number, `built` whether the endpoint exists in a bridge, `errors`/`warnings` the static validator's counts |
| `GET /api/devices/:key`       | `{key, device, issues: [{level, path, message}], built, bridge, number, state}` — `issues` are the static ones plus the running endpoint's conformance violations; `state` as below, or absent when not built                                                            |
| `PUT /api/devices/:key`       | body: the device. Creates or replaces: the file is written, the old endpoint (if any) is removed, the new one built and wired without a restart — the endpoint number stays with the key. A device with validation errors is saved but not built. Answers like `GET`     |
| `DELETE /api/devices/:key`    | removes the device from the file and the bridge; `204`                                                                                                                                                                                                                   |
| `GET /api/devices/:key/state` | `{<endpointId>: {number, state: {<Cluster>: {<attribute>: value}}}}` — the live Matter state of every endpoint of the device; `404` when not built                                                                                                                       |
| `POST /api/validate`          | body `{device}`; answers `{ok, issues}` from the schema and the static validator, nothing is saved                                                                                                                                                                       |
| `POST /api/check`             | body `{}` for the whole configuration or `{devices: {<key>: device}}`; runs the strict dry run of `mqtt2matter --check` (a throw-away node, no network) and answers `{ok, devices: {<key>: issues[]}}` — only devices with issues are listed                             |

## The binding editor

| Route               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/preview` | `{direction: "status", half, payload, attribute?, topic?}` → the payload through the status half's steps; `{direction: "command", half, value, attribute?, fields?}` → the value through the command half's. Answers `{ok, stages: [{step, ok, value?, reason?}], result?, reason?}`; the stages are `extract`, `template`, `map`, `unit`, `scale`, `attribute` (status) and `value`, `scale`, `format`, `wrap`, `payload` (command), only those the half uses. `attribute` (`Cluster.attribute`) gives the attribute's shape (enum names, bitmaps) |
| `POST /api/publish` | `{topic, payload, retain?, qos?}` → publishes; `{published: true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/topics`   | `?prefix=` optional; `[{topic, payload, retain, ts}]` — the topic cache: every topic seen on the subscriptions (`server.topics` plus the bindings'), payloads cut at 16 kB, sorted                                                                                                                                                                                                                                                                                                                                                                  |

## The catalogue

| Route                             | Answer                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/catalog`                | `{deviceTypes: [{name, id, classification, clusters: [{cluster, mandatory, features}]}], clusters: [name…], composites: {"ColorControl.colorHs": {cluster, fields, features, description}, …}, units: [name…], eventChannels: ["Switch"]}` |
| `GET /api/catalog/clusters/:name` | `{name, id, features: [{code, title}], attributes: [{name, id, metatype, nullable, writable, enumMembers?, bitFields?, min?, max?, conformance}], commands: [{name, id, fields}], events: [name…]}`                                        |

## Presets

| Route                         | Answer                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/presets`            | `{presets: [{id, name, description, vendor, variables, shipped, file}], problems: [{file, message}]}` — the shipped presets and every `*.json` below the `presets` directories, read on each call |
| `POST /api/presets/:id/apply` | body `{values: {<variable>: "…"}}`; answers `{device, issues}` — the device the preset yields (`source.kind` `preset`), not saved: `PUT /api/devices/:key` saves it                               |

## Bridges

| Route                                    | Answer                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/bridges`                       | `[{id, port, online, commissioned, pairingCodes: {manualPairingCode, qrPairingCode}, devices: n, fabrics: [{index, label, vendorId, nodeId, fabricId}], windowStatus}]` — `windowStatus` 0 closed, 1 enhanced window open, 2 basic window open |
| `POST /api/bridges/:id/commissioning`    | `{open: true, minutes?}` opens a basic commissioning window with the bridge's passcode (≤ 15 minutes, the default); `{open: false}` closes it; answers the bridge                                                                              |
| `DELETE /api/bridges/:id/fabrics/:index` | removes a fabric (the controller loses the bridge); `204`                                                                                                                                                                                      |

## Adopt

Importers (`src/importers/`, phases 2 and 4) describe devices from a source; the server compares them
with the configured devices (`source.kind` and `source.key`).

| Route                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/adopt`                   | `{importers: [kind…], entries: [{kind, sourceKey, name, vendor, model, state, deviceKey, changes?}]}` — `state` is `new` (not configured; `deviceKey` is the key it would get), `adopted` (configured and equal), `changed` (the source would change it; `changes: [{path, before, after}]`), `orphaned` (configured, gone from the source — marked `source.orphaned` in the file, never removed by the bridge) |
| `POST /api/adopt/resync`           | every importer reads its source again; answers like `GET`                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/adopt/:kind/:sourceKey` | body `{key?}`: a `new` entry is adopted under `key` (default: `deviceKey`); a `changed` one is replaced by the source's version (its key, bridge and `enabled` are kept, the user's edits are not); answers the device like `GET /api/devices/:key`                                                                                                                                                             |

Removing an orphaned device is `DELETE /api/devices/:key`.

## Import and export

| Route              | Answer                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/export`  | the configuration file as it is (`content-disposition: attachment`); `?device=<key>` gives `{<key>: device}` for one device                                                                           |
| `POST /api/import` | `{devices: {<key>: device}}` or `{config: {devices: …}}`, with `replace: true` to drop every device not in the body; each device is validated first, then saved and built one by one; `{imported: n}` |

## Log

| Route          | Answer                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/log` | `?limit=500&after=<id>`; `[{id, ts, level, scope, message}]`, oldest first — the last 2000 lines of the bridge's own log (not matter.js') |

## The event stream

`GET /api/events` upgrades to a WebSocket; every event is one JSON text frame. A client may send
`{"type": "subscribe", "mqtt": false}` to stop receiving MQTT events (and `true` to resume).

| Event        | Fields                                     | When                                                                 |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `hello`      | `version`                                  | right after the connection                                           |
| `mqtt`       | `topic, payload, retain, ts`               | every message on a subscribed topic (payload cut at 16 kB)           |
| `attribute`  | `key, endpoint, cluster, attribute, value` | an attribute of a device's endpoint changed (a status, a controller) |
| `log`        | `entry: {id, ts, level, scope, message}`   | a log line                                                           |
| `devices`    | —                                          | the device list changed (created, replaced, removed, imported)       |
| `bridges`    | —                                          | commissioning state or fabrics changed, a window opened or closed    |
| `discovered` | —                                          | an importer's view of its source changed                             |
| `status`     | `mqtt: boolean`                            | the broker connection came or went                                   |
