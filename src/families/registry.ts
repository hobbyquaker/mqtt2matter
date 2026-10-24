/* What every family shares: the per-endpoint context (options, the enabled features, the bindings it has,
   the command handlers the runtime registered) and `route()`, which hands a controller's command to the
   runtime's handler and answers whether the family applies the value locally. The context is keyed by
   the matter.js Endpoint in a WeakMap, so a behavior finds it through `this.endpoint`. */

import type {Behavior, Endpoint} from '@matter/main';

import type {CommandHandler} from '../engine/runtime.ts';
import type {Logger} from '../log.ts';
import type {Options} from '../model/options.ts';

export interface FamilyContext {
    readonly endpoint: Endpoint;
    readonly options: Options;
    /** enabled feature titles per cluster, e.g. `ColorControl → {HueSaturation, ColorTemperature}` */
    readonly features: ReadonlyMap<string, ReadonlySet<string>>;
    /** the keys with a command half (`OnOff.onOff`, `ColorControl.colorHs`, `WindowCovering.stopMotion`) */
    readonly commands: Map<string, CommandHandler>;
    /** the keys with a status half */
    readonly statuses: ReadonlySet<string>;
    readonly log: Logger;
    /** per-family scratch state (the cover's movement, the switch's queue) */
    readonly scratch: Map<string, unknown>;
}

const contexts = new WeakMap<Endpoint, FamilyContext>();

export function registerContext(context: FamilyContext): void {
    contexts.set(context.endpoint, context);
}

export function forgetContext(endpoint: Endpoint): void {
    contexts.delete(endpoint);
}

export function contextOf(endpoint: Endpoint): FamilyContext | undefined {
    return contexts.get(endpoint);
}

export function hasFeature(context: FamilyContext | undefined, cluster: string, feature: string): boolean {
    return context?.features.get(cluster)?.has(feature) ?? false;
}

export function hasCommand(context: FamilyContext | undefined, key: string): boolean {
    return context?.commands.has(key) ?? false;
}

export function hasStatus(context: FamilyContext | undefined, key: string): boolean {
    return context?.statuses.has(key) ?? false;
}

/**
 * A controller's command for `key`: the runtime's handler publishes it and says whether the value is to be
 * applied locally now. Without a handler the default applies (true): a cluster nobody bound behaves like a
 * local device, so a controller still sees a consistent endpoint.
 */
export async function route(
    endpoint: Endpoint,
    key: string,
    value: unknown,
    fields: Record<string, unknown> = {},
): Promise<boolean> {
    const context = contexts.get(endpoint);
    const handler = context?.commands.get(key);
    if (handler === undefined) {
        return true;
    }
    try {
        return await handler(value, fields);
    } catch (error) {
        context?.log.error(`${key}: publishing the command failed`, error);
        return false;
    }
}

/**
 * Take the behavior's state lock after an await. The default implementations write state synchronously and
 * throw when a `set()` of ours — a status message a moment earlier — still holds it.
 */
export async function lock(behavior: Behavior): Promise<void> {
    const {transaction} = behavior.context;
    await transaction.addResources(behavior);
    await transaction.begin();
}

/** a behavior's state without the feature-dependent typing (our classes extend the servers before `with()`) */
export function loose(state: object): Record<string, unknown> {
    return state as Record<string, unknown>;
}

/** a scratch slot of the context, created on first use */
export function scratch<T>(context: FamilyContext, key: string, create: () => T): T {
    let value = context.scratch.get(key) as T | undefined;
    if (value === undefined) {
        value = create();
        context.scratch.set(key, value);
    }
    return value;
}

/** a controller's transition time in tenths of a second → the template field `transition` in seconds */
export function transitionField(
    context: FamilyContext | undefined,
    transitionTime: number | null | undefined,
): Record<string, unknown> {
    if (transitionTime === null || transitionTime === undefined || context?.options.light.transition === false) {
        return {};
    }
    return {transition: transitionTime / 10};
}
