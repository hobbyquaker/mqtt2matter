/* The OnOff family: a controller's on/off/toggle reaches the handler registered for the endpoint before
   matter.js' default implementation runs. The handler publishes the command and answers whether the new
   value is applied locally now (optimistic, or no status half) or left for the device's status report
   (the controller then sees the change when the device confirms it). Every override waits for the
   behavior's state lock first: the default implementations write state synchronously and throw when a
   `set()` of ours — a status message a moment earlier — still holds it. */

import {OnOffServer as BaseOnOffServer} from '@matter/main/behaviors/on-off';
import type {Behavior, Endpoint} from '@matter/main';

export type OnOffHandler = (value: boolean) => Promise<boolean>;

const handlers = new WeakMap<Endpoint, OnOffHandler>();

export function setOnOffHandler(endpoint: Endpoint, handler: OnOffHandler | undefined): void {
    if (handler === undefined) {
        handlers.delete(endpoint);
    } else {
        handlers.set(endpoint, handler);
    }
}

async function lock(behavior: Behavior): Promise<void> {
    const {transaction} = behavior.context;
    await transaction.addResources(behavior);
    await transaction.begin();
}

/** true when the default implementation is to run (no handler, or the handler asked for a local apply) */
async function route(behavior: Behavior, value: boolean): Promise<boolean> {
    const handler = handlers.get(behavior.endpoint);
    if (handler === undefined) {
        return true;
    }
    return await handler(value);
}

export class OnOffServer extends BaseOnOffServer {
    override async on(): Promise<void> {
        if (await route(this, true)) {
            await lock(this);
            await super.on();
        }
    }

    override async off(): Promise<void> {
        if (await route(this, false)) {
            await lock(this);
            await super.off();
        }
    }

    override async toggle(): Promise<void> {
        if (this.state.onOff) {
            await this.off();
        } else {
            await this.on();
        }
    }
}
