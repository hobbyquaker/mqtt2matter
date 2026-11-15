/* Colour for the light family: the conversions between hue/saturation (0–360°, 0–100 %), CIE xy (0–1) and
   RGB (0–255) come from mqtt-ha-entities (sRGB with its gamma, D65 white; good enough for lights, not for
   colorimetry); the Matter scalings are mqtt2matter's: hue and saturation 0–254, x and y × 65536 up to 65279. */

export {hsToRgb, rgbToHs, rgbToXy, xyToRgb, hsToXy, xyToHs, parseColor} from 'mqtt-ha-entities';
export type {Hs, Xy, Rgb} from 'mqtt-ha-entities';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Matter hue 0–254 ↔ degrees */
export const hueToMatter = (deg: number): number => Math.round((((deg % 360) + 360) % 360) * (254 / 360));
export const hueFromMatter = (v: number): number => Math.round((v / 254) * 360 * 100) / 100;
/** Matter saturation 0–254 ↔ percent */
export const saturationToMatter = (pct: number): number => Math.round(clamp(pct, 0, 100) * 2.54);
export const saturationFromMatter = (v: number): number => Math.round((v / 254) * 100 * 100) / 100;
/** CurrentX/CurrentY = x/y × 65536, at most 65279 (0xFEFF): Matter 1.4 ColorControl, CurrentX/CurrentY */
export const xyToMatter = (v: number): number => Math.min(0xfeff, Math.round(clamp(v, 0, 1) * 65536));
export const xyFromMatter = (v: number): number => Math.round((v / 65536) * 10000) / 10000;
