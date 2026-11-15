/* Can the payload engine run a Home Assistant template? The engine renders Jinja through
   `@huggingface/jinja` with Home Assistant's filters added (docs/config.md, "Templates"); what it cannot
   do — `states()`, `now()`, `this`, the time and regex helpers, macros — must not become a
   mapping that fails at runtime. The importer parses the template with the same library and walks the
   program: every filter, test, called function and free name has to be one the engine provides; a
   `*_template` that is not leaves its mapping unadopted, listed with the template. The check is
   mqtt-ha-entities' (the same names as its engine); what is mqtt2matter's own are the command side's
   variables: the fields the families hand a command template. */

import {checkTemplate as check, type TemplateCheck} from 'mqtt-ha-entities';

export {FILTERS, TESTS, FUNCTIONS, STATUS_VARIABLES} from 'mqtt-ha-entities';
export type {TemplateCheck};

/** the variables of a command half's template: the value, an enum's member name, the families' fields */
export const COMMAND_VARIABLES = new Set([
    'value',
    'name',
    'level',
    'brightness',
    'percent',
    'transition',
    'hue',
    'saturation',
    'h',
    's',
    'x',
    'y',
    'red',
    'green',
    'blue',
    'r',
    'g',
    'b',
    'mireds',
    'kelvin',
    'position',
    'open',
    'percent100ths',
    'mode',
    'speed',
    'action',
]);

/** can the engine render this template with the variables of that side? */
export function checkTemplate(
    source: string,
    side: 'status' | 'command',
    extra: readonly string[] = [],
): TemplateCheck {
    return check(source, side, side === 'command' ? [...COMMAND_VARIABLES, ...extra] : extra);
}
