/* The preset dialog's values: a variable whose default references other variables (`"default": "%item%"`)
   follows them as the user types, until he edits that field himself; a cleared field follows again. The
   server resolves the same way when a value is not sent (src/model/presets.ts presetValues), so a client
   that sends only the identifying variables gets the same name. */

const REFERENCE_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)(?:\|(words))?%/g;
const HAS_REFERENCE = /%[A-Za-z_][A-Za-z0-9_]*(?:\|words)?%/;

/** `%name|words%`: the value with its slashes as spaces, as the server resolves it */
function referenceValue(value: string, modifier: string | undefined): string {
    return modifier === 'words' ? value.replace(/\//g, ' ').replace(/\s+/g, ' ').trim() : value;
}

export interface PresetVariable {
    default?: string;
}

/** whether the variable's default references other variables */
export function follows(variable: PresetVariable | undefined): boolean {
    return HAS_REFERENCE.test(variable?.default ?? '');
}

/**
 * The values with every following variable the user has not edited recomputed from its default: the
 * references resolve to the other variables' values (edited or themselves resolved), the result trimmed.
 */
export function resolveValues(
    variables: Record<string, PresetVariable>,
    values: Record<string, string>,
    edited: ReadonlySet<string>,
): Record<string, string> {
    const resolved = new Map<string, string>();
    const resolve = (name: string, path: string[]): string => {
        const known = resolved.get(name);
        if (known !== undefined) {
            return known;
        }
        const variable = variables[name];
        let value: string;
        if (variable === undefined || path.includes(name)) {
            value = '';
        } else if (!follows(variable) || edited.has(name)) {
            value = values[name] ?? variable.default ?? '';
        } else {
            value = (variable.default ?? '')
                .replace(REFERENCE_PATTERN, (_m, ref: string, modifier: string | undefined) =>
                    referenceValue(resolve(ref, [...path, name]), modifier),
                )
                .trim();
        }
        resolved.set(name, value);
        return value;
    };
    return Object.fromEntries(Object.keys(variables).map((name) => [name, resolve(name, [])]));
}
