/* The cover family: WindowCovering with the movement logic of the maintainer's matterbridge-zigbee2mqtt
   PR #170 as options. Commands set the target and publish it (or the up/down/stop command mappings); the
   device's position reports drive the current position; `operationalStatus` follows from target vs
   current; a report timeout ends a movement nobody reported the end of; an external move (a report while
   no command is in flight) writes a predicted target — the direction's extreme — before the current
   position, so controllers deriving the direction from target/current show it. Two timeouts end a movement
   nobody reported the end of: `reportTimeout` while a command waits for its first report, `reportGap` once
   reports arrive (a cover reporting its travel stops reporting when it stops). The echo filter holds back
   what a bridge like zigbee2mqtt publishes right after a command before the cover moves: the old position
   repeated (until a second report or the report timeout) and the commanded target itself (until a report
   of the travel drops it, or for the report gap: then it was the only report, the end of the movement).
   State-only covers and `moving`/`motor_state` reports bind the composite `motion`; they report the end of
   a movement, so their position reports keep the report timeout. Tilt runs the same machine on its own
   attributes. */

import {
    MovementDirection,
    MovementType,
    WindowCoveringServer as BaseWindowCoveringServer,
} from '@matter/main/behaviors/window-covering';
import {WindowCovering} from '@matter/main/clusters/window-covering';

import type {Decoded} from '../engine/payload.ts';
import {type FamilyContext, contextOf, hasCommand, hasFeature, hasStatus, route, scratch} from './registry.ts';

const {MovementStatus} = WindowCovering;

export const LIFT_TARGET_KEY = 'WindowCovering.targetPositionLiftPercent100ths';
export const TILT_TARGET_KEY = 'WindowCovering.targetPositionTiltPercent100ths';
export const UP_KEY = 'WindowCovering.upOrOpen';
export const DOWN_KEY = 'WindowCovering.downOrClose';
export const STOP_KEY = 'WindowCovering.stopMotion';
export const MOTION_KEY = 'WindowCovering.motion';

const OPEN = 0;
const CLOSED = 10000;
/** a report at the commanded target this far from the current position is taken for an echo (a fifth of the travel) */
const ECHO_JUMP = 2000;

interface Axis {
    readonly name: 'lift' | 'tilt';
    readonly current: 'currentPositionLiftPercent100ths' | 'currentPositionTiltPercent100ths';
    readonly target: 'targetPositionLiftPercent100ths' | 'targetPositionTiltPercent100ths';
    readonly targetKey: string;
    readonly positionAware: string;
}

const LIFT: Axis = {
    name: 'lift',
    current: 'currentPositionLiftPercent100ths',
    target: 'targetPositionLiftPercent100ths',
    targetKey: LIFT_TARGET_KEY,
    positionAware: 'PositionAwareLift',
};
const TILT: Axis = {
    name: 'tilt',
    current: 'currentPositionTiltPercent100ths',
    target: 'targetPositionTiltPercent100ths',
    targetKey: TILT_TARGET_KEY,
    positionAware: 'PositionAwareTilt',
};

interface AxisState {
    /** a controller's command is in flight: the target it set, waiting for the device's reports */
    inFlight: boolean;
    /** the first report after a command is still to come (the echo filter watches it) */
    awaitingFirstReport: boolean;
    /** a report at the target held back by the echo filter: an echo or the only report of the movement */
    candidate: number | undefined;
    /** an external move was detected and runs */
    external: boolean;
    timer: NodeJS.Timeout | undefined;
    /** a controller pressed up/down rather than a percentage */
    viaUpDown: boolean;
    /** a stop was published; the next report is the final position */
    stopping: boolean;
}

function axisState(context: FamilyContext, axis: Axis): AxisState {
    return scratch(context, `cover.${axis.name}`, () => ({
        inFlight: false,
        awaitingFirstReport: true,
        candidate: undefined,
        external: false,
        timer: undefined,
        viaUpDown: false,
        stopping: false,
    }));
}

function clearTimer(state: AxisState): void {
    if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
    }
}

function armTimeout(
    context: FamilyContext,
    axis: Axis,
    state: AxisState,
    seconds: number,
    onExpiry: () => Promise<void>,
): void {
    clearTimer(state);
    state.timer = setTimeout(() => {
        state.timer = undefined;
        onExpiry().catch((error: unknown) => {
            context.log.error(`cover ${axis.name}: report timeout handling failed`, error);
        });
    }, seconds * 1000);
    state.timer.unref();
}

type WcState = Record<string, unknown> & {
    operationalStatus: {global: number; lift: number; tilt: number};
};

function wcState(context: FamilyContext): WcState {
    return (context.endpoint.state as Record<string, unknown>).windowCovering as WcState;
}

async function setWc(context: FamilyContext, patch: Record<string, unknown>): Promise<void> {
    await context.endpoint.set({windowCovering: patch} as never);
}

async function stopAxis(context: FamilyContext, axis: Axis, state: AxisState, snapTargetTo?: number): Promise<void> {
    clearTimer(state);
    state.inFlight = false;
    state.external = false;
    state.stopping = false;
    state.candidate = undefined;
    const current = wcState(context);
    const patch: Record<string, unknown> = {
        operationalStatus: {...current.operationalStatus, [axis.name]: MovementStatus.Stopped},
    };
    if (hasFeature(context, 'WindowCovering', axis.positionAware)) {
        const position = snapTargetTo ?? (current[axis.current] as number | null);
        if (position !== null) {
            patch[axis.target] = position;
            if (snapTargetTo !== undefined) {
                patch[axis.current] = position;
            }
        }
    }
    await setWc(context, patch);
}

/** seconds without a report before a movement whose reports arrive counts as ended */
function gapSeconds(context: FamilyContext): number {
    const {reportGap, reportTimeout} = context.options.cover;
    // a cover with movement reports says when it stops; its position may be reported less often
    return hasStatus(context, MOTION_KEY) ? reportTimeout : reportGap;
}

/** a device's position report on an axis */
async function reportPosition(context: FamilyContext, axis: Axis, value: number): Promise<void> {
    const state = axisState(context, axis);
    const {tolerance, echoFilter, reportTimeout} = context.options.cover;
    const wc = wcState(context);
    const previous = wc[axis.current] as number | null;
    const target = wc[axis.target] as number | null;
    if (state.stopping) {
        // the report after a stop is where the cover came to rest
        await stopAxis(context, axis, state, value);
        return;
    }
    if (state.inFlight) {
        if (echoFilter && previous !== null && target !== null) {
            if (state.awaitingFirstReport && value === previous && target !== value) {
                // the old position repeated right after the command; wait for a second opinion
                state.awaitingFirstReport = false;
                armTimeout(context, axis, state, reportTimeout, async () => {
                    await stopAxis(context, axis, state, value);
                });
                return;
            }
            if (Math.abs(value - target) <= tolerance && Math.abs(value - previous) > ECHO_JUMP) {
                // the commanded target echoed before the cover moved: hold it back (repeats too) until the travel
                // is reported; if nothing follows, it was the only report and the movement ended there
                state.awaitingFirstReport = false;
                if (state.candidate === undefined) {
                    state.candidate = value;
                    armTimeout(context, axis, state, gapSeconds(context), async () => {
                        await stopAxis(context, axis, state, value);
                    });
                }
                return;
            }
        }
        state.awaitingFirstReport = false;
        state.candidate = undefined;
        if (target !== null && Math.abs(value - target) <= tolerance) {
            await stopAxis(context, axis, state, value);
            return;
        }
        await setWc(context, {[axis.current]: value});
        armTimeout(context, axis, state, gapSeconds(context), async () => {
            await stopAxis(context, axis, state);
        });
        return;
    }
    if (previous === null) {
        await setWc(context, {[axis.target]: value, [axis.current]: value});
        return;
    }
    if (value === previous) {
        if (state.external) {
            await stopAxis(context, axis, state, value);
        }
        return;
    }
    // an external move: somebody else moves the cover; predict the target from the direction
    const predicted = value > previous ? CLOSED : OPEN;
    if (!state.external || target !== predicted) {
        await setWc(context, {[axis.target]: predicted});
    }
    state.external = true;
    if (Math.abs(value - predicted) <= tolerance) {
        await stopAxis(context, axis, state, value);
        return;
    }
    await setWc(context, {[axis.current]: value});
    armTimeout(context, axis, state, gapSeconds(context), async () => {
        await stopAxis(context, axis, state);
    });
}

/** the `motion` composite: opening / closing / stopped / open / closed */
async function reportMotion(context: FamilyContext, value: Decoded): Promise<void> {
    const text = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
    const wc = wcState(context);
    const liftState = axisState(context, LIFT);
    const positionAware = hasFeature(context, 'WindowCovering', LIFT.positionAware);
    switch (text) {
        case 'opening':
        case 'closing': {
            const status = text === 'opening' ? MovementStatus.Opening : MovementStatus.Closing;
            const patch: Record<string, unknown> = {
                operationalStatus: {...wc.operationalStatus, lift: status},
            };
            if (positionAware && !liftState.inFlight) {
                patch[LIFT.target] = text === 'opening' ? OPEN : CLOSED;
                liftState.external = true;
            }
            await setWc(context, patch);
            armTimeout(context, LIFT, liftState, context.options.cover.reportTimeout, async () => {
                await stopAxis(context, LIFT, liftState);
            });
            return;
        }
        case 'stopped':
        case 'stop':
        case 'idle':
            await stopAxis(context, LIFT, liftState);
            return;
        case 'open':
            await stopAxis(context, LIFT, liftState, positionAware ? OPEN : undefined);
            return;
        case 'closed':
        case 'close':
            await stopAxis(context, LIFT, liftState, positionAware ? CLOSED : undefined);
            return;
        default:
            throw new Error(`motion: "${text}" is not opening, closing, stopped, open or closed`);
    }
}

/** the status side of WindowCovering; true = handled by the family */
export async function coverStatus(
    context: FamilyContext | undefined,
    attribute: string,
    value: Decoded,
): Promise<boolean> {
    if (context === undefined) {
        return false;
    }
    if (attribute === 'motion') {
        await reportMotion(context, value);
        return true;
    }
    if (attribute === LIFT.current && typeof value === 'number') {
        await reportPosition(context, LIFT, value);
        return true;
    }
    if (attribute === TILT.current && typeof value === 'number') {
        await reportPosition(context, TILT, value);
        return true;
    }
    return false;
}

function positionFields(target: number): Record<string, unknown> {
    return {
        position: Math.round(target / 100),
        percent: Math.round(target / 100),
        /** the inverted scale many devices use: 100 = open */
        open: 100 - Math.round(target / 100),
        percent100ths: target,
    };
}

export class WindowCoveringServer extends BaseWindowCoveringServer {
    override async upOrOpen(): Promise<void> {
        const context = contextOf(this.endpoint);
        if (context !== undefined) {
            axisState(context, LIFT).viaUpDown = true;
            axisState(context, TILT).viaUpDown = true;
        }
        await super.upOrOpen();
    }

    override async downOrClose(): Promise<void> {
        const context = contextOf(this.endpoint);
        if (context !== undefined) {
            axisState(context, LIFT).viaUpDown = true;
            axisState(context, TILT).viaUpDown = true;
        }
        await super.downOrClose();
    }

    override async handleMovement(
        type: MovementType,
        reversed: boolean,
        direction: MovementDirection,
        targetPercent100ths?: number,
    ): Promise<void> {
        const context = contextOf(this.endpoint);
        const axis = type === MovementType.Lift ? LIFT : TILT;
        if (context === undefined) {
            await super.handleMovement(type, reversed, direction, targetPercent100ths);
            return;
        }
        const state = axisState(context, axis);
        const viaUpDown = state.viaUpDown;
        state.viaUpDown = false;
        clearTimer(state);
        const positionAware = hasFeature(context, 'WindowCovering', axis.positionAware);
        const directionKey = direction === MovementDirection.Close ? DOWN_KEY : UP_KEY;
        let applied: boolean;
        const fields = targetPercent100ths === undefined ? {} : positionFields(targetPercent100ths);
        if (
            (viaUpDown || !positionAware || !hasCommand(context, axis.targetKey)) &&
            hasCommand(context, directionKey)
        ) {
            applied = await route(
                this.endpoint,
                directionKey,
                direction === MovementDirection.Close ? 'close' : 'open',
                fields,
            );
        } else if (targetPercent100ths !== undefined) {
            applied = await route(this.endpoint, axis.targetKey, targetPercent100ths, fields);
        } else {
            applied = true;
        }
        if (applied) {
            // matter.js does not await this worker: the command's transaction is gone, so the writes go through
            // the endpoint in a transaction of their own
            if (positionAware && targetPercent100ths !== undefined) {
                await setWc(context, {[axis.current]: targetPercent100ths});
            } else {
                // nothing will report the end of the movement: it is over as far as Matter is concerned
                const current = wcState(context);
                await setWc(context, {
                    operationalStatus: {...current.operationalStatus, [axis.name]: MovementStatus.Stopped},
                });
            }
            return;
        }
        state.inFlight = true;
        state.external = false;
        state.awaitingFirstReport = true;
        state.candidate = undefined;
        armTimeout(context, axis, state, context.options.cover.reportTimeout, async () => {
            context.log.info(`cover ${axis.name}: no position report within the timeout, movement counts as ended`);
            await stopAxis(context, axis, state);
        });
    }

    override async handleStopMovement(): Promise<void> {
        const context = contextOf(this.endpoint);
        if (context === undefined) {
            await super.handleStopMovement();
            return;
        }
        const applied = await route(this.endpoint, STOP_KEY, 'stop');
        for (const axis of [LIFT, TILT]) {
            const state = axisState(context, axis);
            clearTimer(state);
            state.inFlight = false;
            state.external = false;
            state.candidate = undefined;
            if (applied || !hasFeature(context, 'WindowCovering', axis.positionAware)) {
                await stopAxis(context, axis, state);
            } else {
                // the device reports where it stopped; until then (or the timeout) the movement goes on
                state.stopping = true;
                armTimeout(context, axis, state, context.options.cover.reportTimeout, async () => {
                    await stopAxis(context, axis, state);
                });
            }
        }
    }
}
