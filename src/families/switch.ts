/* The switch family: GenericSwitch events from a device's action strings. The event channel `Switch`
   receives a press kind — `single`, `double`, `triple`, a number of presses, `long`, `press`, `release`,
   `longRelease` — and plays it as position changes into matter.js' SwitchServer, whose own machine
   emits the events controllers expect (initialPress, shortRelease, multiPressOngoing/Complete, longPress,
   longRelease) with the delays the options set. A latching switch takes the value as the position. Kinds
   arriving while one plays are queued, so a double press stays a double press. */

import {SwitchServer as BaseSwitchServer} from '@matter/main/behaviors/switch';

import type {Decoded} from '../engine/payload.ts';
import {type FamilyContext, scratch} from './registry.ts';

export class SwitchServer extends BaseSwitchServer {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const WORDS: Record<string, number> = {
    single: 1,
    click: 1,
    short: 1,
    double: 2,
    triple: 3,
    quadruple: 4,
    quintuple: 5,
};

type Step = {kind: 'press'; position: number} | {kind: 'release'} | {kind: 'wait'; ms: number};

/** the position changes a press kind consists of */
export function pressSteps(kind: string, options: FamilyContext['options']['switch']): Step[] | undefined {
    const text = kind
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    const {pressDuration, longPressDelay} = options;
    const steps: Step[] = [];
    const count = WORDS[text] ?? (/^\d+$/.test(text) ? Number(text) : undefined);
    if (count !== undefined && count > 0) {
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                steps.push({kind: 'wait', ms: pressDuration});
            }
            steps.push({kind: 'press', position: 1}, {kind: 'wait', ms: pressDuration}, {kind: 'release'});
        }
        return steps;
    }
    switch (text) {
        case 'long':
        case 'hold':
        case 'long_press':
            return [
                {kind: 'press', position: 1},
                {kind: 'wait', ms: longPressDelay + pressDuration},
                {kind: 'release'},
            ];
        case 'press':
        case 'initial_press':
            return [{kind: 'press', position: 1}];
        case 'release':
        case 'long_release':
        case 'short_release':
            return [{kind: 'release'}];
        default:
            return undefined;
    }
}

interface Queue {
    chain: Promise<void>;
}

async function setPosition(context: FamilyContext, position: number): Promise<void> {
    await context.endpoint.set({switch: {rawPosition: position}} as never);
}

/** play a press kind (momentary) or a position (latching) */
export async function switchEvent(context: FamilyContext, value: Decoded): Promise<void> {
    const options = context.options.switch;
    if (options.kind === 'latching') {
        const position = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
        if (!Number.isInteger(position) || position < 0 || position >= options.numberOfPositions) {
            throw new Error(`switch: ${JSON.stringify(value)} is not a position`);
        }
        await setPosition(context, position);
        return;
    }
    const kind = typeof value === 'string' ? value : JSON.stringify(value);
    const steps = pressSteps(kind, options);
    if (steps === undefined) {
        throw new Error(`switch: "${kind}" is not a press kind (single, double, triple, <n>, long, press, release)`);
    }
    const queue = scratch<Queue>(context, 'switch.queue', () => ({chain: Promise.resolve()}));
    const run = queue.chain.then(async () => {
        for (const step of steps) {
            if (step.kind === 'wait') {
                await sleep(step.ms);
            } else {
                await setPosition(context, step.kind === 'press' ? step.position : 0);
            }
        }
    });
    queue.chain = run.catch((error: unknown) => {
        context.log.error(`switch: playing "${kind}" failed`, error);
    });
    await run;
}
