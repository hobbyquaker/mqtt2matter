/* The UI's languages: German and English, every string in both (messages.ts). `t()` is reactive: a
   language change re-renders everything that used it. The key is the English text; `{name}` is a
   parameter. A key without a translation shows as itself, so nothing is ever blank. */

import {MESSAGES} from './messages.ts';

export type Language = 'de' | 'en';
export type LanguageChoice = Language | 'auto';

export const LANGUAGES: readonly Language[] = ['de', 'en'];
export const LANGUAGE_LABELS: Record<Language, string> = {de: 'Deutsch', en: 'English'};

const KEY = 'mqtt2matter.language';

export function browserLanguage(list: readonly string[] = navigatorLanguages()): Language {
    for (const entry of list) {
        const code = entry.toLowerCase().split('-')[0];
        if (code === 'de' || code === 'en') {
            return code;
        }
    }
    return 'en';
}

function navigatorLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') {
        return [];
    }
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

export function storedChoice(): LanguageChoice {
    try {
        const stored = localStorage.getItem(KEY);
        return stored === 'de' || stored === 'en' ? stored : 'auto';
    } catch {
        return 'auto';
    }
}

export function resolveLanguage(choice: LanguageChoice): Language {
    return choice === 'auto' ? browserLanguage() : choice;
}

export function interpolate(text: string, params: Record<string, unknown>): string {
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

class I18n {
    choice = $state<LanguageChoice>(storedChoice());
    readonly language = $derived(resolveLanguage(this.choice));

    set(choice: LanguageChoice): void {
        this.choice = choice;
        try {
            localStorage.setItem(KEY, choice);
        } catch {
            // a private window: the choice lives until the tab closes
        }
    }

    t(key: string, params?: Record<string, unknown>): string {
        const entry = MESSAGES[key];
        const text = entry === undefined ? key : entry[this.language];
        return params === undefined ? text : interpolate(text, params);
    }
}

export const i18n = new I18n();

/** `t('Devices')`, `t('{count} devices', {count: 7})` */
export function t(key: string, params?: Record<string, unknown>): string {
    return i18n.t(key, params);
}
