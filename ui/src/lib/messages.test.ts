/* Every string the UI shows exists in both languages: the catalogue has `de` and `en` for every key,
   and every `t('…')` in the sources names a key the catalogue has. */

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {browserLanguage, interpolate, resolveLanguage} from './i18n.svelte.ts';
import {MESSAGES} from './messages.ts';

function sources(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            files.push(...sources(path));
        } else if (
            (name.endsWith('.svelte') || name.endsWith('.ts')) &&
            !name.endsWith('.test.ts') &&
            name !== 'messages.ts'
        ) {
            files.push(path);
        }
    }
    return files;
}

describe('the catalogue', () => {
    it('has German and English for every key', () => {
        for (const [key, message] of Object.entries(MESSAGES)) {
            expect(message.de, key).not.toBe('');
            expect(message.en, key).not.toBe('');
            // the parameters of the key appear in both texts
            for (const param of key.match(/\{\w+\}/g) ?? []) {
                expect(message.de, `${key} (de)`).toContain(param);
                expect(message.en, `${key} (en)`).toContain(param);
            }
        }
    });

    it('covers every t() in the sources', () => {
        const missing = new Set<string>();
        for (const file of sources(join(import.meta.dirname, '..'))) {
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
                const key = (match[1] ?? '').replace(/\\'/g, "'");
                if (!(key in MESSAGES)) {
                    missing.add(`${key} (${file.split('/').slice(-2).join('/')})`);
                }
            }
            for (const match of text.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
                const key = match[1] ?? '';
                if (!(key in MESSAGES)) {
                    missing.add(`${key} (${file.split('/').slice(-2).join('/')})`);
                }
            }
        }
        expect([...missing]).toEqual([]);
    });

    it('knows the theme names', () => {
        expect(Object.keys(MESSAGES)).toEqual(expect.arrayContaining(['like the system', 'light', 'dark']));
    });
});

describe('the language', () => {
    it('interpolates parameters and leaves unknown ones', () => {
        expect(interpolate('{count} devices on {bridge}', {count: 3, bridge: 'default'})).toBe('3 devices on default');
        expect(interpolate('{what}', {})).toBe('{what}');
    });

    it('takes the browser order, English behind it', () => {
        expect(browserLanguage(['fr-FR', 'de-AT', 'en'])).toBe('de');
        expect(browserLanguage(['en-GB', 'de'])).toBe('en');
        expect(browserLanguage(['fr'])).toBe('en');
        expect(browserLanguage([])).toBe('en');
        expect(resolveLanguage('de')).toBe('de');
    });
});
