# Architecture

mqtt2matter is one package with internal module boundaries. The manual device model is the core;
everything else generates it (importers), renders it (UI) or runs it (engine, families, matter).

```
src/
  config/      the configuration file and the environment: schema, loading, defaults
  model/       the manual model — devices, endpoints, bindings, family options — the @matter/model catalogue,
               the static validator, the preset format
  engine/      the payload engine (pure functions over the model's halves: extract, template, map, unit, scale,
               wrap …), the Jinja templates, the binding runtime (availability, expire, get, coalescing)
  families/    cluster semantics that live in code: the servers that route controller commands, the status
               hooks (colour composites, the cover's movement, fan consistency, battery levels), switch events
  mqtt/        the broker connection and the topic cache (last payload per topic)
  matter/      the node manager (n ≥ 1 bridges), one bridge = ServerNode + aggregator, the model-driven endpoint
               builder, the strict dry run, ids, the shard map
  importers/   foreign descriptions → model devices: patch.ts (baseline + edits), sync.ts (the report, the
               re-sync, orphaning — shared), actions.ts (press kinds — shared), z2m/ (zigbee2mqtt), ha/ (Home
               Assistant MQTT discovery) — docs/importers.md
  commands/    the command line's subcommands beyond start and --check (`--import-z2m`, `--install`)
  server/      node:http + ws: the REST API and the event stream of docs/api.md, the config file as the UI
               edits it (compact, atomic writes), the catalogue as JSON, the preview of a binding's halves,
               the importers as the server runs them, the built UI as static files
  app.ts       wiring and lifecycle; devices are added and removed while it runs
  main.ts      the command line entry (`--check` is the dry run)
  log.ts       the leveled, scoped logger
ui/            the Svelte 5 app (Vite, TypeScript strict, svelte-check): built into ui/dist, served by
               src/server; it talks to the server through docs/api.md only
```

## Data flow

MQTT message → `mqtt/` (cache) → `engine/runtime` finds the bindings on that topic → `engine/payload`
decodes (extract, template, map, type, unit, scale, offset, invert, round, then the attribute's shape from the
model: enum names, bitmap fields, integers) → the endpoint handle in `matter/` hands the value to the
cluster's family (a composite, a state machine) or sets the attribute.

Controller command → the family server in `families/` (e.g. `LevelControlServer.moveToLevelLogic`) →
`route()` finds the handler the runtime registered for the key → `engine/payload` encodes (numeric steps
inverted, format, template, wrap) → `mqtt/` publishes (coalesced per topic when the endpoint asks) → the family
applies the value locally only when the binding is optimistic (its default without a status half, or without
a related one); otherwise the device's status report sets it.

Controller write of a writable attribute → matter.js applies it → the endpoint handle's observer sees the
change with an online context → the same handler publishes it → the family keeps the cluster consistent (a
fan's mode from its percent).

## Dependency rules

Enforced by `no-restricted-imports` in `eslint.config.js` per folder:

- `importers/` depend on `model/` and `mqtt/` only — never on `matter/`, `families/`, `engine/`, `config/`,
  `server/`. An importer writes `config.devices` entries with `source` metadata; the runtime does not know
  where a device came from. `commands/` wires an importer to the configuration file and the broker for the
  command line; the server does the same for the UI.
- `families/` depend on `engine/` outputs, `model/` and matter.js — never on an importer, config loading,
  `mqtt/` or the server.
- `engine/` and `model/` are pure: no matter.js node, no MQTT, no files. They use `@matter/model` (the data
  model) for lookups; the model's catalogue is the only place that reads it.
- `mqtt/` knows nothing above it.
- `server/` may use everything below it; `ui/` (outside `src/`, its own tsconfig, type-checked by svelte-check)
  talks to `server/` through the documented REST/WS contract only — nothing from `src/` is imported there.

## The model-driven endpoint

`matter/device-types.ts` builds an endpoint type from matter.js' own device definitions (every `*Device` it
ships, plus the utility `PowerSource`) and `@matter/model`: the first device type is the endpoint's type, the
others go into the Descriptor's device type list with their mandatory clusters; the clusters are the device
types' mandatory ones, the optional ones a binding or the config names, and any other cluster a binding names;
each cluster's server is the family's class (it routes commands) with the device type's alterations re-applied
(read off the requirement's schema: `remainingTime` mandatory on colour lights, `currentLevel` 1–254 on
dimmable ones), else matter.js' default; the features are the union of what the device type requires, what
the bindings imply and what the config asks for. `matter/cluster-defaults.ts` holds the few mandatory
attributes the model gives no default for. There is no table of device types.

## Validation

Two layers (study §2.5): `model/validate.ts` checks a device statically against the model — device types,
clusters, attributes, features, conformance under the endpoint's features, map and format values against the
attribute's shape, templates — and the app refuses to build a device with errors; `matter/check.ts` builds every
device in a throw-away `ServerNode` of its own `Environment` with `endpoint.validation=strict` and memory
storage, never online, and reports what matter.js refuses plus the `DeviceTypeConformanceService`'s violations
(`mqtt2matter --check`). Production runs matter.js' `warn` mode and logs each endpoint's violations once.

## Identity and persistence

- A device's key in `config.devices` is its Matter endpoint id. matter.js persists endpoint numbers per id,
  so numbers survive restarts and config edits as long as the key stays. Renaming a device changes `name`,
  never the key.
- Child endpoints are `<key>~<endpoint id>`, parts of the device's endpoint.
- `BridgedDeviceBasicInformation.uniqueId` is a hash of the bridge id and the device key.
- Each bridge is a `ServerNode` with its own id, storage directory (under `storage`), port, passcode and
  discriminator; the mDNS service is shared process-wide. Passcode and discriminator are random on the
  first start unless configured, and persisted by matter.js.
- `storage/shards.json` maps device keys to bridge ids: written once, never rebalanced. 1.0 runs one
  bridge; the map exists so the multi-bridge split (1.1) moves no device between nodes.

## A rule learned the hard way

matter.js does not await every hook it calls: `WindowCoveringServer.handleMovement` and `handleStopMovement`
are workers; the command's transaction commits while they run. A behavior that writes `this.state` after an
`await` in such a hook hits a committed transaction, and that error is fatal for the whole node. Family code
writes through `endpoint.set()` (a transaction of its own) after any `await` in a hook it does not know to be
awaited; `lock()` + `this.state` is only for the hooks matter.js awaits (`on`/`off`, `moveToLevelLogic`, the
colour logic, `lockDoor`).

## Testing

- Unit tests over the pure parts (engine steps, templates, units, the runtime with fakes, the validator,
  presets, the endpoint builder, config, topic cache, shard map) with vitest.
- `test/check.test.ts` runs the strict dry run; `test/e2e.test.ts` and `test/families.e2e.test.ts` start an
  in-process aedes broker on an ephemeral port and a real matter.js `ServerNode` on a free UDP port, drive it
  through the node's own interaction API (`endpoint.act`) and, for attribute writes, emit the attribute's change
  with an online context. Nothing binds a fixed port.
- `test/server.test.ts` runs the whole API against the real application (broker, node, the config file in a
  temporary directory, the zigbee2mqtt importer with the test corpus); `ui/test/e2e/` are the Playwright
  tests of the UI, against the same stack started by `ui/test/serve.ts` on an ephemeral port (the global
  setup starts it and hands the address to the tests). The UI's own unit tests (`ui/src/**/*.test.ts`, run
  with `ui/vitest.config.ts`) check among other things that every string has both languages.
