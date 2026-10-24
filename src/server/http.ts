/* The small HTTP toolkit the API is built on: a method + path router with `:params`, JSON in and out
   with the errors the UI understands, and the static files of the built UI. No framework: the API is
   thirty routes, and node:http does the rest. */

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {extname, join, normalize, resolve, sep} from 'node:path';

export class HttpError extends Error {
    readonly status: number;
    readonly details: unknown;

    constructor(status: number, message: string, details?: unknown) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.details = details;
    }
}

export interface Request {
    method: string;
    path: string;
    params: Record<string, string>;
    query: URLSearchParams;
    /** the parsed JSON body, undefined without one */
    body: unknown;
    raw: IncomingMessage;
}

export type Handler = (request: Request, response: ServerResponse) => unknown;

interface Route {
    method: string;
    pattern: RegExp;
    names: string[];
    handler: Handler;
}

const MAX_BODY = 8 * 1024 * 1024;

/** JSON with matter.js' values made serialisable: bigints as strings, byte arrays as hex */
export function toJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') {
            return v.toString();
        }
        if (v instanceof Uint8Array) {
            return Buffer.from(v).toString('hex');
        }
        return v;
    });
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
    const text = value === undefined ? 'null' : toJson(value);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(text);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
    const type = request.headers['content-type'] ?? '';
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY) {
            throw new HttpError(413, 'the request body is too large');
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0) {
        return undefined;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!type.includes('json')) {
        return text;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new HttpError(400, `the request body is not valid JSON: ${(error as Error).message}`);
    }
}

export class Router {
    private readonly routes: Route[] = [];

    add(method: string, path: string, handler: Handler): this {
        const names: string[] = [];
        const source = path
            .split('/')
            .map((segment) => {
                if (segment.startsWith(':')) {
                    names.push(segment.slice(1));
                    return '([^/]+)';
                }
                return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            })
            .join('/');
        this.routes.push({method, pattern: new RegExp(`^${source}$`), names, handler});
        return this;
    }

    /** dispatch; false when no route matches the path at all */
    async dispatch(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const path = url.pathname;
        let pathMatched = false;
        for (const route of this.routes) {
            const match = route.pattern.exec(path);
            if (match === null) {
                continue;
            }
            pathMatched = true;
            if (route.method !== request.method) {
                continue;
            }
            const params: Record<string, string> = {};
            route.names.forEach((name, index) => {
                params[name] = decodeURIComponent(match[index + 1] ?? '');
            });
            try {
                const body = await readBody(request);
                const result = await route.handler(
                    {method: route.method, path, params, query: url.searchParams, body, raw: request},
                    response,
                );
                if (!response.headersSent) {
                    sendJson(response, result === undefined ? 204 : 200, result ?? null);
                }
            } catch (error) {
                if (response.headersSent) {
                    response.end();
                } else if (error instanceof HttpError) {
                    sendJson(response, error.status, {error: error.message, details: error.details});
                } else {
                    sendJson(response, 500, {error: error instanceof Error ? error.message : String(error)});
                }
            }
            return true;
        }
        if (pathMatched) {
            sendJson(response, 405, {error: `${request.method ?? ''} is not allowed on ${path}`});
            return true;
        }
        return false;
    }
}

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
};

/** serve the files of `root`; any path that is not a file gets `index.html` (the UI routes by hash) */
export async function serveStatic(root: string, path: string, response: ServerResponse): Promise<void> {
    const base = resolve(root);
    const wanted = normalize(join(base, path === '/' ? 'index.html' : path));
    let file = wanted.startsWith(base + sep) ? wanted : join(base, 'index.html');
    try {
        const info = await stat(file);
        if (!info.isFile()) {
            file = join(base, 'index.html');
        }
    } catch {
        file = join(base, 'index.html');
    }
    let size: number;
    try {
        size = (await stat(file)).size;
    } catch {
        response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
        response.end('the UI is not built: run `npm run build`');
        return;
    }
    const hashed = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(file) && file.includes(`${sep}assets${sep}`);
    response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-length': size,
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(response);
}
