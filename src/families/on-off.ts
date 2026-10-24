/* The OnOff family: a controller's on/off/toggle reaches the runtime's handler before matter.js' default
   implementation runs. The handler publishes the command and answers whether the new value is applied
   locally now (optimistic, or no status half) or left for the device's status report (the controller then
   sees the change when the device confirms it).

   A momentary endpoint (`options.onOff.momentary`, a scene or a button behind an outlet) is a trigger:
   `on` publishes and the endpoint falls back to off after the given time; `off` only sets it off. */

import {OnOffServer as BaseOnOffServer} from '@matter/main/behaviors/on-off';

import {contextOf, type FamilyContext, lock, route, scratch} from './registry.ts';

export const ON_OFF_KEY = 'OnOff.onOff';

interface Momentary {
    timer: NodeJS.Timeout | undefined;
}

function momentaryOf(context: FamilyContext | undefined): number {
    return context?.options.onOff.momentary ?? 0;
}

/** fall back to off after the momentary time; a second press restarts it */
function armReset(context: FamilyContext, ms: number): void {
    const state = scratch<Momentary>(context, 'onOff.momentary', () => ({timer: undefined}));
    if (state.timer !== undefined) {
        clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
        state.timer = undefined;
        context.endpoint.set({onOff: {onOff: false}} as never).catch((error: unknown) => {
            context.log.error('the momentary reset to off failed', error);
        });
    }, ms);
    state.timer.unref();
}

export class OnOffServer extends BaseOnOffServer {
    override async on(): Promise<void> {
        const context = contextOf(this.endpoint);
        const momentary = momentaryOf(context);
        if (await route(this.endpoint, ON_OFF_KEY, true)) {
            await lock(this);
            await super.on();
        }
        if (context !== undefined && momentary > 0) {
            armReset(context, momentary);
        }
    }

    override async off(): Promise<void> {
        // a trigger has nothing to switch off: no command, only the local state
        if (momentaryOf(contextOf(this.endpoint)) > 0 || (await route(this.endpoint, ON_OFF_KEY, false))) {
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
