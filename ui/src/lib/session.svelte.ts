/* Whether this tab may use the API: the server's auth mode and whether the request is authenticated. The app
   shows the login until it is; a 401 from any request (the session expired) brings the login back. */

import {type AuthState, api, onUnauthorized} from './api.ts';

class Session {
    state = $state<AuthState | undefined>(undefined);
    /** the answer of /api/auth could not be read (the server is down) */
    unreachable = $state(false);

    constructor() {
        onUnauthorized(() => {
            if (this.state !== undefined) {
                this.state = {...this.state, authenticated: false};
            }
        });
    }

    async load(): Promise<void> {
        try {
            this.state = await api.auth();
            this.unreachable = false;
        } catch {
            this.unreachable = true;
        }
    }

    async login(password: string): Promise<void> {
        this.state = await api.login(password);
    }

    async logout(): Promise<void> {
        const mode = this.state?.mode;
        const logoutUrl = this.state?.logoutUrl;
        if (mode === 'proxy') {
            if (logoutUrl !== undefined) {
                window.location.href = logoutUrl;
            }
            return;
        }
        this.state = await api.logout();
    }
}

export const session = new Session();
