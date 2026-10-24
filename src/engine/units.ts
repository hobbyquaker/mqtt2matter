/* The named unit conversions of the payload engine: a device's unit → the Matter attribute's unit on the
   way in (`toMatter`), the inverse on the way out (`fromMatter`). Each is a pure function pair; the names
   are the `unit` field of a half (model/schema.ts). */

import type {Unit} from '../model/schema.ts';

interface Conversion {
    toMatter(value: number): number;
    fromMatter(value: number): number;
}

function linear(fromRange: [number, number], toRange: [number, number]): Conversion {
    const [a0, a1] = fromRange;
    const [b0, b1] = toRange;
    const factor = (b1 - b0) / (a1 - a0);
    return {
        toMatter: (v) => b0 + (v - a0) * factor,
        fromMatter: (v) => a0 + (v - b0) / factor,
    };
}

export const UNITS: Record<Unit, Conversion> = {
    celsius: {toMatter: (c) => c * 100, fromMatter: (v) => v / 100},
    fahrenheit: {toMatter: (f) => (((f - 32) * 5) / 9) * 100, fromMatter: (v) => (v / 100) * (9 / 5) + 32},
    kelvin: {toMatter: (k) => (k <= 0 ? 0 : 1_000_000 / k), fromMatter: (m) => (m <= 0 ? 0 : 1_000_000 / m)},
    percent100ths: linear([0, 100], [0, 10000]),
    halfPercent: linear([0, 100], [0, 200]),
    percentLevel: {
        toMatter: (p) => (p <= 0 ? 0 : Math.max(1, (p / 100) * 254)),
        fromMatter: (l) => (l <= 0 ? 0 : (l / 254) * 100),
    },
    byteLevel: {
        toMatter: (b) => (b <= 0 ? 0 : Math.max(1, (b / 255) * 254)),
        fromMatter: (l) => (l <= 0 ? 0 : (l / 254) * 255),
    },
    lux: {
        toMatter: (lux) => (lux <= 0 ? 0 : 10000 * Math.log10(lux) + 1),
        fromMatter: (v) => (v <= 0 ? 0 : 10 ** ((v - 1) / 10000)),
    },
    volt: {toMatter: (v) => v * 1000, fromMatter: (mv) => mv / 1000},
    degrees254: linear([0, 360], [0, 254]),
    percent254: linear([0, 100], [0, 254]),
    seconds10ths: {toMatter: (s) => s * 10, fromMatter: (t) => t / 10},
};

export function toMatter(unit: Unit, value: number): number {
    return UNITS[unit].toMatter(value);
}

export function fromMatter(unit: Unit, value: number): number {
    return UNITS[unit].fromMatter(value);
}
