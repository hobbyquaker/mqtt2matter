import {describe, expect, it} from 'vitest';

import {UNITS, fromMatter, toMatter} from '../src/engine/units.ts';
import {UnitSchema} from '../src/model/schema.ts';

describe('units', () => {
    it.each([
        ['celsius', 21.5, 2150],
        ['fahrenheit', 68, 2000],
        ['kelvin', 2700, 370.37],
        ['percent100ths', 55.5, 5550],
        ['halfPercent', 50, 100],
        ['percentLevel', 100, 254],
        ['percentLevel', 0, 0],
        ['byteLevel', 255, 254],
        ['byteLevel', 1, 1],
        ['lux', 100, 20001],
        ['lux', 0, 0],
        ['volt', 2.9, 2900],
        ['degrees254', 360, 254],
        ['percent254', 50, 127],
        ['seconds10ths', 1.5, 15],
    ] as const)('%s: %d → %d', (unit, device, matter) => {
        expect(toMatter(unit, device)).toBeCloseTo(matter, 1);
    });

    it('round-trips every unit', () => {
        for (const unit of UnitSchema.options) {
            const sample = unit === 'kelvin' ? 4000 : unit === 'lux' ? 350 : 42;
            expect(fromMatter(unit, toMatter(unit, sample))).toBeCloseTo(sample, 3);
        }
        expect(Object.keys(UNITS).sort()).toEqual([...UnitSchema.options].sort());
    });
});
