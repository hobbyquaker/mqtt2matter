/* Action names → buttons with press kinds, shared by the importers: zigbee2mqtt's `action` enum and Home
   Assistant's `event_types` and device trigger types. A device's actions are strings like `single`,
   `double`, `hold`, `release` (one button), `single_l1` / `single_l2` (a button per endpoint),
   `brightness_up_click` / `brightness_up_hold` / `arrow_left_click` (IKEA and Philips remotes: a button
   per prefix), `on` / `off` / `toggle` / `open` / `close` / `stop` (remotes whose actions name the button
   only: one single-press button each), `shake` / `tap` / `flip90` (the cube: gestures as buttons).
   Continuous actions — `brightness_move_up`, `brightness_stop`, `hue_move`, `rotate_left`, `scene_1` — are
   no presses and are left out. Each button becomes one GenericSwitch endpoint. Home Assistant's
   `button_short_press` / `button_double_press` / `button_long_release` (device triggers) and ESPHome's
   `double_press` / `long_press` (event types) are read through the same table. */

const KINDS: Record<string, string> = {
    single: 'single',
    click: 'single',
    press: 'single',
    short: 'single',
    short_press: 'single',
    single_press: 'single',
    double: 'double',
    double_click: 'double',
    double_press: 'double',
    triple: 'triple',
    triple_click: 'triple',
    triple_press: 'triple',
    quadruple: 'quadruple',
    quadruple_press: 'quadruple',
    quintuple: 'quintuple',
    quintuple_press: 'quintuple',
    many: 'quintuple',
    hold: 'long',
    long: 'long',
    long_press: 'long',
    long_click: 'long',
    release: 'longRelease',
    hold_release: 'longRelease',
    long_release: 'longRelease',
    short_release: 'release',
};

/** longest first, so `long_release` wins over `release` */
const KIND_WORDS = Object.keys(KINDS).sort((a, b) => b.length - a.length);
const SUFFIX = new RegExp(`^(.+?)_(${KIND_WORDS.join('|')})$`);
const PREFIX = new RegExp(`^(${KIND_WORDS.join('|')})_(.+)$`);

/** actions that are no presses: continuous moves and steps, scene recalls, rotations, identify */
const NOT_A_PRESS = [
    /(^|_)(move|step|level|scene|recall|rotate|identify)(_|$)/,
    /^.+_stop$/,
    /^(hue|saturation|color|colour|brightness|color_temperature)_/,
];

export const PRESS_COUNT: Record<string, number> = {single: 1, double: 2, triple: 3, quadruple: 4, quintuple: 5};

export interface Button {
    /** the button's name: `''` for the device's only button, else the prefix/suffix (`l1`, `brightness_up`, `on`) */
    name: string;
    /** action value → press kind */
    kinds: Map<string, string>;
}

export interface ParsedActions {
    buttons: Button[];
    /** action values that are no presses */
    ignored: string[];
}

export function parseAction(value: string): {button: string; kind: string} | undefined {
    const v = value.trim().toLowerCase();
    if (v === '') {
        return undefined;
    }
    const direct = KINDS[v];
    if (direct !== undefined) {
        return {button: '', kind: direct};
    }
    const suffix = SUFFIX.exec(v);
    if (suffix !== null) {
        return {button: suffix[1] ?? '', kind: KINDS[suffix[2] ?? ''] ?? 'single'};
    }
    const prefix = PREFIX.exec(v);
    if (prefix !== null) {
        return {button: prefix[2] ?? '', kind: KINDS[prefix[1] ?? ''] ?? 'single'};
    }
    if (NOT_A_PRESS.some((pattern) => pattern.test(v))) {
        return undefined;
    }
    return {button: v, kind: 'single'};
}

export function parseActions(values: readonly (string | number)[]): ParsedActions {
    const buttons = new Map<string, Button>();
    const ignored: string[] = [];
    for (const raw of values) {
        const value = String(raw);
        const parsed = parseAction(value);
        if (parsed === undefined) {
            ignored.push(value);
            continue;
        }
        let button = buttons.get(parsed.button);
        if (button === undefined) {
            button = {name: parsed.button, kinds: new Map()};
            buttons.set(parsed.button, button);
        }
        button.kinds.set(value, parsed.kind);
    }
    return {buttons: [...buttons.values()], ignored};
}

/** the most presses a button's kinds announce (the switch family's `multiPressMax`) */
export function multiPressMax(button: Button): number {
    let max = 1;
    for (const kind of button.kinds.values()) {
        max = Math.max(max, PRESS_COUNT[kind] ?? 1);
    }
    return max;
}
