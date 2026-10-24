/* The theme switch: system, light or dark, remembered in the browser. The CSS has the dark values
   twice — under `prefers-color-scheme` and under `[data-theme='dark']` — so both directions work. */

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'mqtt2matter.theme';
const ORDER: Theme[] = ['system', 'light', 'dark'];

export function getTheme(): Theme {
    try {
        const stored = localStorage.getItem(KEY);
        return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
        return 'system';
    }
}

export function applyTheme(theme: Theme = getTheme()): void {
    const root = document.documentElement;
    if (theme === 'system') {
        root.removeAttribute('data-theme');
    } else {
        root.setAttribute('data-theme', theme);
    }
}

export function setTheme(theme: Theme): void {
    try {
        localStorage.setItem(KEY, theme);
    } catch {
        // a private window: the choice lives until the tab closes
    }
    applyTheme(theme);
}

export function nextTheme(theme: Theme): Theme {
    return ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';
}
