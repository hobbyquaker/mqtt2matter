# Architecture

mqtt2matter is one package with internal module boundaries. The manual device model is the core;
everything else generates it (importers), renders it (UI) or runs it (engine, families, matter).

```
src/
  config/      the configuration file and the environment: schema, loading, defaults
  model/       the manual model — devices, endpoints, bindings — and attribute references
  engine/      the payload engine (pure functions over the model's halves) and the binding runtime
  families/    cluster semantics that live in code: command hooks and state machines per family
  mqtt/        the broker connection and the topic cache (last payload per topic)
  matter/      the node manager (n ≥ 1 bridges), one bridge = ServerNode + aggregator, ids, the shard map
  importers/   (phase 2, 4) foreign descriptions → model devices: zigbee2mqtt, Home Assistant discovery
  server/      (phase 3) REST + WebSocket for the UI; the contract is docs/api.md
  ui/          (phase 3) the Svelte 5 app
  app.ts       wiring and lifecycle
  main.ts      the command line entry
  log.ts       the leveled, scoped logger
```

## Data flow

MQTT message → `mqtt/` (cache) → `engine/runtime` finds the bindings on that topic → `engine/payload`
decodes (extract, type, map) → the device handle in `matter/` sets the attribute.

Controller command → the family behavior in `families/` (e.g. `OnOffServer.on()`) → the handler the
runtime registered → `engine/payload` encodes (format) → `mqtt/` publishes → the attribute is applied
locally only when the binding is optimistic (its default without a status half); otherwise the device's
status report sets it.

## Dependency rules

Enforced by `no-restricted-imports` in `eslint.config.js` per folder:

- `importers/` depend on `model/` and `mqtt/` only — never on `matter/`, `families/`, `engine/`, `config/`,
  `server/`. An importer writes `config.devices` entries with `source` metadata; the runtime does not know
  where a device came from.
- `families/` depend on `engine/` outputs and matter.js — never on an importer, config loading, `mqtt/` or
  the server.
- `engine/` and `model/` are pure: no matter.js node, no MQTT, no files. They may use `@matter/model`
  (the data model) for lookups.
- `mqtt/` knows nothing above it.
- `ui/` talks to `server/` through the documented REST/WS contract only.

## Identity and persistence

- A device's key in `config.devices` is its Matter endpoint id. matter.js persists endpoint numbers per id,
  so numbers survive restarts and config edits as long as the key stays. Renaming a device changes `name`,
  never the key.
- Child endpoints (phase 1) are `<key>~<endpoint id>`.
- `BridgedDeviceBasicInformation.uniqueId` is a hash of the bridge id and the device key.
- Each bridge is a `ServerNode` with its own id, storage directory (under `storage`), port, passcode and
  discriminator; the mDNS service is shared process-wide. Passcode and discriminator are random on the
  first start unless configured, and persisted by matter.js.
- `storage/shards.json` maps device keys to bridge ids: written once, never rebalanced. 1.0 runs one
  bridge; the map exists so the multi-bridge split (1.1) moves no device between nodes.

## Testing

- Unit tests over the pure parts (engine, config, topic cache, shard map) with vitest.
- The end-to-end test starts an in-process aedes broker on an ephemeral port and a real matter.js
  `ServerNode` on a free UDP port, drives it through the node's own interaction API (`endpoint.act`),
  and restarts it to prove the endpoint numbers hold. Nothing binds a fixed port.
