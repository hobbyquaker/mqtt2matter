/* The OnOff family: a controller's on/off/toggle reaches the runtime's handler before matter.js' default
   implementation runs. The handler publishes the command and answers whether the new value is applied
   locally now (optimistic, or no status half) or left for the device's status report (the controller then
   sees the change when the device confirms it). */

import {OnOffServer as BaseOnOffServer} from '@matter/main/behaviors/on-off';

import {lock, route} from './registry.ts';

export const ON_OFF_KEY = 'OnOff.onOff';

export class OnOffServer extends BaseOnOffServer {
    override async on(): Promise<void> {
        if (await route(this.endpoint, ON_OFF_KEY, true)) {
            await lock(this);
            await super.on();
        }
    }

    override async off(): Promise<void> {
        if (await route(this.endpoint, ON_OFF_KEY, false)) {
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
