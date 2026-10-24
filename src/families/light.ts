/* The light family: LevelControl and ColorControl. Commands: a controller's level, hue/saturation, xy or
   colour temperature goes to whichever binding the endpoint has — the composite `colorHs` / `colorXy` /
   `colorRgb` (converted as needed) or the plain attributes — with the on-command ordering of HA's
   `on_command_type` and the transition time as a template field; applied locally only when the binding
   says so. Status: the composites set every representation the endpoint's features carry and arbitrate
   `colorMode` / `enhancedColorMode`, unless the config binds `colorMode` itself. */

import {ColorControlServer as BaseColorControlServer} from '@matter/main/behaviors/color-control';
import {LevelControlServer as BaseLevelControlServer} from '@matter/main/behaviors/level-control';
import {ColorControl} from '@matter/main/clusters/color-control';
import {LevelControl} from '@matter/main/clusters/level-control';
import type {MaybePromise} from '@matter/main';

import type {Decoded} from '../engine/payload.ts';
import {
    type Hs,
    type Rgb,
    type Xy,
    hsToRgb,
    hsToXy,
    hueFromMatter,
    hueToMatter,
    parseColor,
    rgbToHs,
    rgbToXy,
    saturationFromMatter,
    saturationToMatter,
    xyFromMatter,
    xyToHs,
    xyToMatter,
    xyToRgb,
} from './color.ts';
import {OnOffServer} from './on-off.ts';
import {
    type FamilyContext,
    contextOf,
    hasCommand,
    hasFeature,
    hasStatus,
    lock,
    loose,
    route,
    transitionField,
} from './registry.ts';

export const LEVEL_KEY = 'LevelControl.currentLevel';
export const ON_OFF_KEY = 'OnOff.onOff';
export const HS_KEY = 'ColorControl.colorHs';
export const XY_KEY = 'ColorControl.colorXy';
export const RGB_KEY = 'ColorControl.colorRgb';
export const CT_KEY = 'ColorControl.colorTemperatureMireds';
export const COLOR_MODE_KEY = 'ColorControl.colorMode';

const {ColorMode, EnhancedColorMode} = ColorControl;

function levelFields(
    level: number,
    context: FamilyContext | undefined,
    transitionTime: number | null,
): Record<string, unknown> {
    return {
        level,
        brightness: level,
        percent: Math.round((level / 254) * 100),
        ...transitionField(context, transitionTime),
    };
}

export class LevelControlServer extends BaseLevelControlServer {
    override async moveToLevelLogic(
        level: number,
        transitionTime: number | null,
        withOnOff: boolean,
        _options?: LevelControl.Options,
    ): Promise<void> {
        const context = contextOf(this.endpoint);
        const fields = levelFields(level, context, transitionTime);
        const turnOn = level > this.minLevel;
        const onCommandType = context?.options.light.onCommandType ?? 'last';
        const onOffBound = hasCommand(context, ON_OFF_KEY);
        let applyOnOff = true;
        if (withOnOff && onOffBound && onCommandType === 'first' && turnOn) {
            applyOnOff = await route(this.endpoint, ON_OFF_KEY, true, fields);
        }
        const applyLevel = await route(this.endpoint, LEVEL_KEY, level, fields);
        if (withOnOff && onOffBound && onCommandType !== 'brightness' && !(onCommandType === 'first' && turnOn)) {
            applyOnOff = await route(this.endpoint, ON_OFF_KEY, turnOn, fields);
        }
        await lock(this);
        if (applyLevel) {
            this.state.currentLevel = level;
        }
        if (withOnOff && applyOnOff && this.endpoint.behaviors.has(OnOffServer)) {
            const onOff = this.agent.get(OnOffServer);
            await lock(onOff);
            onOff.state.onOff = turnOn;
        }
    }

    override moveLogic(
        moveMode: LevelControl.MoveMode,
        _rate: number | null,
        withOnOff: boolean,
        options?: LevelControl.Options,
    ): MaybePromise {
        const target = moveMode === LevelControl.MoveMode.Up ? this.maxLevel : this.minLevel;
        return this.moveToLevelLogic(target, null, withOnOff, options);
    }

    override stepLogic(
        stepMode: LevelControl.StepMode,
        stepSize: number,
        transitionTime: number | null,
        withOnOff: boolean,
        options?: LevelControl.Options,
    ): MaybePromise {
        const current = this.state.currentLevel ?? this.minLevel;
        const raw = stepMode === LevelControl.StepMode.Up ? current + stepSize : current - stepSize;
        const target = Math.min(this.maxLevel, Math.max(this.minLevel, raw));
        return this.moveToLevelLogic(target, transitionTime, withOnOff, options);
    }

    override stopLogic(): MaybePromise {
        // a bridge has no running transition to stop
    }
}

type ColorPatch = Record<string, unknown>;

/** every representation the endpoint has for the colour, plus the colour mode */
function patchFor(context: FamilyContext | undefined, color: {hs?: Hs; xy?: Xy}, preferred: 'hs' | 'xy'): ColorPatch {
    const hasHs = hasFeature(context, 'ColorControl', 'HueSaturation');
    const hasXy = hasFeature(context, 'ColorControl', 'Xy');
    const hs = color.hs ?? (color.xy === undefined ? undefined : xyToHs(color.xy));
    const xy = color.xy ?? (color.hs === undefined ? undefined : hsToXy(color.hs));
    const patch: ColorPatch = {};
    if (hasHs && hs !== undefined) {
        patch.currentHue = hueToMatter(hs.hue);
        patch.currentSaturation = saturationToMatter(hs.saturation);
    }
    if (hasXy && xy !== undefined) {
        patch.currentX = xyToMatter(xy.x);
        patch.currentY = xyToMatter(xy.y);
    }
    if (!hasStatus(context, COLOR_MODE_KEY)) {
        const mode =
            preferred === 'hs' && hasHs
                ? ColorMode.CurrentHueAndCurrentSaturation
                : hasXy
                  ? ColorMode.CurrentXAndCurrentY
                  : hasHs
                    ? ColorMode.CurrentHueAndCurrentSaturation
                    : undefined;
        if (mode !== undefined) {
            patch.colorMode = mode;
            patch.enhancedColorMode = mode;
        }
    }
    return patch;
}

/** the status side of ColorControl: composites and the colour-mode arbitration; undefined = not handled */
export function colorStatusPatch(
    context: FamilyContext | undefined,
    attribute: string,
    value: Decoded,
): ColorPatch | undefined {
    switch (attribute) {
        case 'colorHs': {
            const [hue, saturation] = parseColor(value, ['hue', 'saturation'], {h: 'hue', s: 'saturation'}) ?? [];
            if (hue === undefined || saturation === undefined) {
                throw new Error(`colorHs: ${JSON.stringify(value)} is not {hue, saturation}`);
            }
            return patchFor(context, {hs: {hue, saturation}}, 'hs');
        }
        case 'colorXy': {
            const [x, y] = parseColor(value, ['x', 'y']) ?? [];
            if (x === undefined || y === undefined) {
                throw new Error(`colorXy: ${JSON.stringify(value)} is not {x, y}`);
            }
            return patchFor(context, {xy: {x, y}}, 'xy');
        }
        case 'colorRgb': {
            const [r, g, b] = parseColor(value, ['r', 'g', 'b'], {red: 'r', green: 'g', blue: 'b'}) ?? [];
            if (r === undefined || g === undefined || b === undefined) {
                throw new Error(`colorRgb: ${JSON.stringify(value)} is not {r, g, b}`);
            }
            const rgb: Rgb = {r, g, b};
            return patchFor(context, {hs: rgbToHs(rgb), xy: rgbToXy(rgb)}, 'hs');
        }
        case 'colorTemperatureMireds':
            return hasStatus(context, COLOR_MODE_KEY)
                ? {colorTemperatureMireds: value}
                : {
                      colorTemperatureMireds: value,
                      colorMode: ColorMode.ColorTemperatureMireds,
                      enhancedColorMode: EnhancedColorMode.ColorTemperatureMireds,
                  };
        case 'currentHue':
        case 'currentSaturation':
            return hasStatus(context, COLOR_MODE_KEY)
                ? {[attribute]: value}
                : {
                      [attribute]: value,
                      colorMode: ColorMode.CurrentHueAndCurrentSaturation,
                      enhancedColorMode: EnhancedColorMode.CurrentHueAndCurrentSaturation,
                  };
        case 'currentX':
        case 'currentY':
            return hasStatus(context, COLOR_MODE_KEY)
                ? {[attribute]: value}
                : {
                      [attribute]: value,
                      colorMode: ColorMode.CurrentXAndCurrentY,
                      enhancedColorMode: EnhancedColorMode.CurrentXAndCurrentY,
                  };
        default:
            return undefined;
    }
}

function colorFields(
    hs: Hs,
    xy: Xy,
    rgb: Rgb,
    context: FamilyContext | undefined,
    transitionTime: number,
): Record<string, unknown> {
    return {
        hue: hs.hue,
        saturation: hs.saturation,
        h: hs.hue,
        s: hs.saturation,
        x: xy.x,
        y: xy.y,
        red: rgb.r,
        green: rgb.g,
        blue: rgb.b,
        r: rgb.r,
        g: rgb.g,
        b: rgb.b,
        ...transitionField(context, transitionTime),
    };
}

export class ColorControlServer extends BaseColorControlServer {
    /** publish a colour through the binding the endpoint has, in the controller's representation */
    private async publishColor(
        color: {hs?: Hs; xy?: Xy},
        preferred: 'hs' | 'xy',
        transitionTime: number,
    ): Promise<boolean> {
        const context = contextOf(this.endpoint);
        const hs = color.hs ?? (color.xy === undefined ? {hue: 0, saturation: 0} : xyToHs(color.xy));
        const xy = color.xy ?? hsToXy(hs);
        const rgb = color.hs === undefined ? xyToRgb(xy) : hsToRgb(hs);
        const fields = colorFields(hs, xy, rgb, context, transitionTime);
        const order: [string, unknown][] =
            preferred === 'hs'
                ? [
                      [HS_KEY, {hue: hs.hue, saturation: hs.saturation}],
                      [RGB_KEY, rgb],
                      [XY_KEY, xy],
                  ]
                : [
                      [XY_KEY, xy],
                      [RGB_KEY, rgb],
                      [HS_KEY, {hue: hs.hue, saturation: hs.saturation}],
                  ];
        for (const [key, value] of order) {
            if (hasCommand(context, key)) {
                return await route(this.endpoint, key, value, fields);
            }
        }
        if (
            preferred === 'hs' &&
            (hasCommand(context, 'ColorControl.currentHue') || hasCommand(context, 'ColorControl.currentSaturation'))
        ) {
            const a = await route(this.endpoint, 'ColorControl.currentHue', hueToMatter(hs.hue), fields);
            const b = await route(
                this.endpoint,
                'ColorControl.currentSaturation',
                saturationToMatter(hs.saturation),
                fields,
            );
            return a && b;
        }
        if (hasCommand(context, 'ColorControl.currentX') || hasCommand(context, 'ColorControl.currentY')) {
            const a = await route(this.endpoint, 'ColorControl.currentX', xyToMatter(xy.x), fields);
            const b = await route(this.endpoint, 'ColorControl.currentY', xyToMatter(xy.y), fields);
            return a && b;
        }
        return true;
    }

    private async applyColor(color: {hs?: Hs; xy?: Xy}, preferred: 'hs' | 'xy'): Promise<void> {
        await lock(this);
        const patch = patchFor(contextOf(this.endpoint), color, preferred);
        Object.assign(loose(this.state), patch);
    }

    override async moveToHueAndSaturationLogic(
        targetHue: number,
        targetSaturation: number,
        transitionTime: number,
    ): Promise<void> {
        const hs = {hue: hueFromMatter(targetHue), saturation: saturationFromMatter(targetSaturation)};
        if (await this.publishColor({hs}, 'hs', transitionTime)) {
            await this.applyColor({hs}, 'hs');
        }
    }

    override async moveToHueLogic(
        targetHue: number,
        _direction: ColorControl.Direction,
        transitionTime: number,
        isEnhancedHue = false,
    ): Promise<void> {
        if (isEnhancedHue) {
            return;
        }
        await this.moveToHueAndSaturationLogic(
            targetHue,
            (loose(this.state).currentSaturation as number | undefined) ?? 0,
            transitionTime,
        );
    }

    override async moveToSaturationLogic(targetSaturation: number, transitionTime: number): Promise<void> {
        await this.moveToHueAndSaturationLogic(
            (loose(this.state).currentHue as number | undefined) ?? 0,
            targetSaturation,
            transitionTime,
        );
    }

    override async moveToColorLogic(targetX: number, targetY: number, transitionTime: number): Promise<void> {
        const xy = {x: xyFromMatter(targetX), y: xyFromMatter(targetY)};
        if (await this.publishColor({xy}, 'xy', transitionTime)) {
            await this.applyColor({xy}, 'xy');
        }
    }

    override async moveToColorTemperatureLogic(targetMireds: number, transitionTime: number): Promise<void> {
        const context = contextOf(this.endpoint);
        const fields = {
            mireds: targetMireds,
            kelvin: Math.round(1_000_000 / targetMireds),
            ...transitionField(context, transitionTime),
        };
        if (await route(this.endpoint, CT_KEY, targetMireds, fields)) {
            await lock(this);
            const state = loose(this.state);
            state.colorTemperatureMireds = targetMireds;
            if (!hasStatus(context, COLOR_MODE_KEY)) {
                state.colorMode = ColorMode.ColorTemperatureMireds;
                state.enhancedColorMode = EnhancedColorMode.ColorTemperatureMireds;
            }
        }
    }

    override stopHueAndSaturationMovement(): MaybePromise {
        // nothing moves in a bridge
    }

    override stopAllColorMovement(): MaybePromise {
        // nothing moves in a bridge
    }
}
