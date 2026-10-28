/* Device keys: the pattern the server accepts (src/model/schema.ts DEVICE_KEY_PATTERN), a key suggested
   from a name, and a key that no existing device has. */

export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

const MAX_KEY = 64;

/** the key a name suggests: lower case, runs of other characters as one dash */
export function keyFromName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_KEY);
}

/**
 * `base` when no device has it, else `base-2`, `base-3`, …: the first that is free. The suffix fits into the
 * key's length. An empty base stays empty.
 */
export function freeKey(base: string, taken: Iterable<string>): string {
    if (base === '') {
        return '';
    }
    const used = new Set(taken);
    if (!used.has(base)) {
        return base;
    }
    for (let n = 2; ; n++) {
        const suffix = `-${n}`;
        const candidate = `${base.slice(0, MAX_KEY - suffix.length)}${suffix}`;
        if (!used.has(candidate)) {
            return candidate;
        }
    }
}
