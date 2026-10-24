/* The preset files: the shipped ones in the package's `presets/` directory and the user's directories
   from `config.presets`, every `*.json` below them. Read on demand, so a file the user drops in is
   there without a restart; a file that does not parse is reported, not fatal. */

import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {type Preset, PresetError, parsePreset} from '../model/presets.ts';

export interface PresetFile {
    preset: Preset;
    file: string;
    shipped: boolean;
}

export interface PresetProblem {
    file: string;
    message: string;
}

export interface PresetLibrary {
    presets: PresetFile[];
    problems: PresetProblem[];
}

/** the package's own presets directory */
export const SHIPPED_PRESETS = resolve(new URL('../../presets', import.meta.url).pathname);

async function jsonFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, {withFileTypes: true});
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await jsonFiles(path)));
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
            files.push(path);
        }
    }
    return files.sort();
}

export async function loadPresets(userDirs: readonly string[], shippedDir = SHIPPED_PRESETS): Promise<PresetLibrary> {
    const presets: PresetFile[] = [];
    const problems: PresetProblem[] = [];
    const seen = new Set<string>();
    const dirs = [{dir: shippedDir, shipped: true}, ...userDirs.map((dir) => ({dir: resolve(dir), shipped: false}))];
    for (const {dir, shipped} of dirs) {
        for (const file of await jsonFiles(dir)) {
            try {
                const preset = parsePreset(JSON.parse(await readFile(file, 'utf8')));
                if (seen.has(preset.id)) {
                    problems.push({file, message: `preset id ${preset.id} is already taken`});
                    continue;
                }
                seen.add(preset.id);
                presets.push({preset, file, shipped});
            } catch (error) {
                problems.push({
                    file,
                    message: error instanceof PresetError ? error.message : (error as Error).message,
                });
            }
        }
    }
    return {presets, problems};
}
