# Changelog

## Unreleased

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
