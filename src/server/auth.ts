/* Who may use the UI and its API. Three modes, as the maintainer's other web UIs have them:

   - `none`: everyone who reaches the port (the default; keep the port on a trusted network);
   - `password`: one password; a login answers an HttpOnly, SameSite=Strict session cookie; sessions live in
     memory and end with the process, after `sessionHours`, or at a logout;
   - `proxy`: a reverse proxy (nginx with authentik, Authelia, oauth2-proxy, …) authenticates and sets a
     header with the user (`X-Remote-User`); a request without it is refused. Only safe when nothing but the
     proxy reaches the port — bind `server.host` to 127.0.0.1 or firewall it.

   The password is kept as an scrypt hash (node's own, no dependency): `scrypt$<N>$<r>$<p>$<salt>$<hash>`,
   salt and hash base64. A plain string in the configuration is hashed at start and works too, with a warning. */

import {randomBytes, scrypt as scryptCallback, type ScryptOptions, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';

export type AuthMode = 'none' | 'password' | 'proxy';

export interface AuthSettings {
    mode: AuthMode;
    password?: string | undefined;
    proxyHeader: string;
    proxyLogoutUrl?: string | undefined;
    sessionHours: number;
}

export const COOKIE = 'mqtt2matter_session';

const KEY_LENGTH = 32;
const COST = {N: 16384, r: 8, p: 1};
/** failed logins per address within the window before further attempts are refused */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function scrypt(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, length, {...options, maxmem: 64 * 1024 * 1024}, (error, key) => {
            if (error === null) {
                resolve(key);
            } else {
                reject(error);
            }
        });
    });
}

export function isPasswordHash(value: string): boolean {
    return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value);
}

/** the stored form of a password */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, COST);
    return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    if (!isPasswordHash(stored)) {
        return false;
    }
    const [, n, r, p, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash ?? '', 'base64');
    const key = await scrypt(password, Buffer.from(salt ?? '', 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface AuthState {
    mode: AuthMode;
    authenticated: boolean;
    /** proxy mode: the user the proxy named */
    user?: string;
    /** proxy mode: where the UI sends a logout */
    logoutUrl?: string;
}

function cookieToken(request: IncomingMessage): string | undefined {
    const header = request.headers.cookie ?? '';
    const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(header);
    return match?.[1];
}

/** behind a TLS-terminating proxy the cookie gets `Secure` */
function isHttps(request: IncomingMessage): boolean {
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return proto?.split(',')[0]?.trim() === 'https' || 'encrypted' in request.socket;
}

export class Auth {
    private settings: AuthSettings;
    /** the scrypt hash in password mode */
    private hash: string | undefined;
    /** session token → expiry (ms) */
    private readonly sessions = new Map<string, number>();
    private readonly failures = new Map<string, number[]>();
    private readonly now: () => number;

    private constructor(settings: AuthSettings, hash: string | undefined, now: () => number) {
        this.settings = settings;
        this.hash = hash;
        this.now = now;
    }

    /** a plain password in the settings is hashed here; `plain` says so, for a warning */
    static async create(settings: AuthSettings, now: () => number = Date.now): Promise<{auth: Auth; plain: boolean}> {
        const password = settings.password;
        const plain = password !== undefined && !isPasswordHash(password);
        const hash = password === undefined ? undefined : plain ? await hashPassword(password) : password;
        return {auth: new Auth(settings, hash, now), plain};
    }

    /** open to everyone: the default when no settings are given */
    static open(): Auth {
        return new Auth({mode: 'none', proxyHeader: 'X-Remote-User', sessionHours: 24 * 7}, undefined, Date.now);
    }

    get mode(): AuthMode {
        return this.settings.mode;
    }

    /** the stored hash in password mode (kept when the mode is set again without a new password) */
    get passwordHash(): string | undefined {
        return this.hash;
    }

    /** the running settings, the password masked */
    view(): AuthSettings {
        return {...this.settings, password: this.hash === undefined ? undefined : '***'};
    }

    private proxyUser(request: IncomingMessage): string | undefined {
        const value = request.headers[this.settings.proxyHeader.toLowerCase()];
        const user = (Array.isArray(value) ? value[0] : value)?.trim();
        return user === undefined || user === '' ? undefined : user;
    }

    private validSession(request: IncomingMessage): boolean {
        const token = cookieToken(request);
        if (token === undefined) {
            return false;
        }
        const expires = this.sessions.get(token);
        if (expires === undefined) {
            return false;
        }
        if (expires < this.now()) {
            this.sessions.delete(token);
            return false;
        }
        return true;
    }

    /** may this request use the API (and the event stream)? */
    check(request: IncomingMessage): boolean {
        switch (this.settings.mode) {
            case 'none':
                return true;
            case 'proxy':
                return this.proxyUser(request) !== undefined;
            case 'password':
                return this.validSession(request);
        }
    }

    state(request: IncomingMessage): AuthState {
        const state: AuthState = {mode: this.settings.mode, authenticated: this.check(request)};
        if (this.settings.mode === 'proxy') {
            const user = this.proxyUser(request);
            if (user !== undefined) {
                state.user = user;
            }
            if (this.settings.proxyLogoutUrl !== undefined) {
                state.logoutUrl = this.settings.proxyLogoutUrl;
            }
        }
        return state;
    }

    /** too many failed logins from this address lately? */
    throttled(address: string): boolean {
        const since = this.now() - FAILURE_WINDOW_MS;
        const recent = (this.failures.get(address) ?? []).filter((at) => at > since);
        this.failures.set(address, recent);
        return recent.length >= MAX_FAILURES;
    }

    /** a session for the password, or undefined; a failure is counted against the address */
    async login(password: string, address: string): Promise<string | undefined> {
        const ok = this.hash !== undefined && (await verifyPassword(password, this.hash));
        if (!ok) {
            this.failures.set(address, [...(this.failures.get(address) ?? []), this.now()]);
            return undefined;
        }
        this.failures.delete(address);
        return this.newSession();
    }

    newSession(): string {
        const token = randomBytes(32).toString('hex');
        this.sessions.set(token, this.now() + this.settings.sessionHours * 3600 * 1000);
        return token;
    }

    logout(request: IncomingMessage): void {
        const token = cookieToken(request);
        if (token !== undefined) {
            this.sessions.delete(token);
        }
    }

    /** the Set-Cookie value for a session, or the one that clears it */
    cookie(request: IncomingMessage, token: string | undefined): string {
        const secure = isHttps(request) ? '; Secure' : '';
        return token === undefined
            ? `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
            : `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${this.settings.sessionHours * 3600}${secure}`;
    }

    /** apply new settings at once (the UI's access settings); every session ends, `hash` is already a hash */
    reconfigure(settings: AuthSettings, hash: string | undefined): void {
        this.settings = settings;
        this.hash = hash;
        this.sessions.clear();
    }
}
