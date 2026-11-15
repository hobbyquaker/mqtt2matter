/* Templates: Home Assistant's `value_template`-style Jinja, rendered by mqtt-ha-entities — the engine
   shared with she's entity layer (@huggingface/jinja with the Home Assistant filters it lacks added).
   The payload engine, the model's validation and the importers all render through this module. */

export {Template, TemplateError, template, renderTemplate} from 'mqtt-ha-entities';
