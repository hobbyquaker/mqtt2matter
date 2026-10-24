/* Colour conversions for the light family: hue/saturation (0–360°, 0–100 %), CIE xy (0–1) and RGB (0–255)
   into one another, plus the Matter scalings (hue and saturation 0–254, x and y 0–65535). sRGB with its
   gamma on the RGB side, D65 white; good enough for lights, not for colorimetry. */

export interface Hs {
    hue: number;
    saturation: number;
}
export interface Xy {
    x: number;
    y: number;
}
export interface Rgb {
    r: number;
    g: number;
    b: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function hsToRgb({hue, saturation}: Hs, value = 1): Rgb {
    const h = (((hue % 360) + 360) % 360) / 60;
    const s = clamp(saturation / 100, 0, 1);
    const c = value * s;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = value - c;
    let r: number;
    let g: number;
    let b: number;
    if (h < 1) {
        [r, g, b] = [c, x, 0];
    } else if (h < 2) {
        [r, g, b] = [x, c, 0];
    } else if (h < 3) {
        [r, g, b] = [0, c, x];
    } else if (h < 4) {
        [r, g, b] = [0, x, c];
    } else if (h < 5) {
        [r, g, b] = [x, 0, c];
    } else {
        [r, g, b] = [c, 0, x];
    }
    return {r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255)};
}

export function rgbToHs({r, g, b}: Rgb): Hs {
    const rn = clamp(r, 0, 255) / 255;
    const gn = clamp(g, 0, 255) / 255;
    const bn = clamp(b, 0, 255) / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
        if (max === rn) {
            hue = 60 * (((gn - bn) / delta) % 6);
        } else if (max === gn) {
            hue = 60 * ((bn - rn) / delta + 2);
        } else {
            hue = 60 * ((rn - gn) / delta + 4);
        }
    }
    if (hue < 0) {
        hue += 360;
    }
    const saturation = max === 0 ? 0 : (delta / max) * 100;
    return {hue: Math.round(hue * 100) / 100, saturation: Math.round(saturation * 100) / 100};
}

function gammaDecode(c: number): number {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gammaEncode(c: number): number {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function rgbToXy({r, g, b}: Rgb): Xy {
    const rl = gammaDecode(clamp(r, 0, 255) / 255);
    const gl = gammaDecode(clamp(g, 0, 255) / 255);
    const bl = gammaDecode(clamp(b, 0, 255) / 255);
    const X = rl * 0.4124 + gl * 0.3576 + bl * 0.1805;
    const Y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
    const Z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505;
    const sum = X + Y + Z;
    if (sum === 0) {
        return {x: 0.3127, y: 0.329};
    }
    return {x: Math.round((X / sum) * 10000) / 10000, y: Math.round((Y / sum) * 10000) / 10000};
}

export function xyToRgb({x, y}: Xy, brightness = 1): Rgb {
    if (y <= 0) {
        return {r: 0, g: 0, b: 0};
    }
    const Y = brightness;
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);
    let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
    let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 + Y * -0.204 + Z * 1.057;
    const max = Math.max(r, g, b);
    if (max > 1) {
        r /= max;
        g /= max;
        b /= max;
    }
    r = gammaEncode(clamp(r, 0, 1));
    g = gammaEncode(clamp(g, 0, 1));
    b = gammaEncode(clamp(b, 0, 1));
    const top = Math.max(r, g, b);
    if (top > 0) {
        r /= top;
        g /= top;
        b /= top;
    }
    return {r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255)};
}

export function hsToXy(hs: Hs): Xy {
    return rgbToXy(hsToRgb(hs));
}

export function xyToHs(xy: Xy): Hs {
    return rgbToHs(xyToRgb(xy));
}

/** Matter hue 0–254 ↔ degrees */
export const hueToMatter = (deg: number): number => Math.round((((deg % 360) + 360) % 360) * (254 / 360));
export const hueFromMatter = (v: number): number => Math.round((v / 254) * 360 * 100) / 100;
/** Matter saturation 0–254 ↔ percent */
export const saturationToMatter = (pct: number): number => Math.round(clamp(pct, 0, 100) * 2.54);
export const saturationFromMatter = (v: number): number => Math.round((v / 254) * 100 * 100) / 100;
/** Matter x/y 0–65535 ↔ 0–1 */
export const xyToMatter = (v: number): number => Math.round(clamp(v, 0, 1) * 65535);
export const xyFromMatter = (v: number): number => Math.round((v / 65535) * 10000) / 10000;

/** parse a colour object, array or `"a,b(,c)"` into named fields */
export function parseColor(
    value: unknown,
    names: readonly string[],
    aliases: Record<string, string> = {},
): number[] | undefined {
    let parts: unknown[];
    if (typeof value === 'string') {
        parts = value.split(/[,;\s]+/).filter((p) => p !== '');
    } else if (Array.isArray(value)) {
        parts = value;
    } else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        parts = names.map((name) => {
            if (name in record) {
                return record[name];
            }
            for (const [alias, target] of Object.entries(aliases)) {
                if (target === name && alias in record) {
                    return record[alias];
                }
            }
            return undefined;
        });
    } else {
        return undefined;
    }
    if (parts.length < names.length) {
        return undefined;
    }
    const numbers = parts.slice(0, names.length).map((p) => (typeof p === 'number' ? p : Number(p)));
    return numbers.every((n) => Number.isFinite(n)) ? numbers : undefined;
}
