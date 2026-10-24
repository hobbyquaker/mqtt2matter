/* The hash router: `#/<page>[/<rest>]`. The page is one of the shell's tabs, the rest belongs to the
   page (the device key on the editor). */

export type Page = 'devices' | 'presets' | 'adopt' | 'bridges' | 'mqtt' | 'log' | 'check' | 'config';

export const PAGES: readonly Page[] = ['devices', 'presets', 'adopt', 'bridges', 'mqtt', 'log', 'check', 'config'];

export interface Route {
    page: Page;
    rest: string;
}

export function parseHash(hash: string): Route {
    const raw = hash.replace(/^#\/?/, '');
    const [first, ...rest] = raw.split('/');
    const page = (PAGES as readonly string[]).includes(first ?? '') ? (first as Page) : 'devices';
    const tail = rest
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
    return {page, rest: page === (first ?? '') ? tail : ''};
}

export function hashFor(page: Page, rest = ''): string {
    return rest === '' ? `#/${page}` : `#/${page}/${rest.split('/').map(encodeURIComponent).join('/')}`;
}

class Router {
    route = $state<Route>(parseHash(typeof location === 'undefined' ? '' : location.hash));

    constructor() {
        if (typeof window !== 'undefined') {
            window.addEventListener('hashchange', () => {
                this.route = parseHash(location.hash);
            });
        }
    }

    go(page: Page, rest = ''): void {
        const next = hashFor(page, rest);
        if (location.hash === next) {
            this.route = parseHash(next);
        } else {
            location.hash = next;
        }
    }
}

export const router = new Router();
