/* The robot vacuum family: RvcRunMode and RvcOperationalState. matter.js' run mode server only checks and
   applies a mode change, its operational state server implements no command; here a controller's mode change
   goes to the `RvcRunMode.currentMode` mapping and pause, resume and go home to the `invoke` mappings of the
   same names, applied locally only where nothing reports back. The defaults give the clusters the two run
   modes Matter demands (Idle, Cleaning) and the operational states a vacuum has. */

import {ModeUtils} from '@matter/main/behaviors/mode-base';
import {RvcOperationalStateServer as BaseRvcOperationalStateServer} from '@matter/main/behaviors/rvc-operational-state';
import {RvcRunModeServer as BaseRvcRunModeServer} from '@matter/main/behaviors/rvc-run-mode';
import {ModeBase} from '@matter/main/clusters/mode-base';
import {OperationalState} from '@matter/main/clusters/operational-state';
import {RvcOperationalState} from '@matter/main/clusters/rvc-operational-state';
import {RvcRunMode} from '@matter/main/clusters/rvc-run-mode';

import {contextOf, hasCommand, lock, route} from './registry.ts';

export const RUN_MODE_KEY = 'RvcRunMode.currentMode';
export const PAUSE_KEY = 'RvcOperationalState.pause';
export const RESUME_KEY = 'RvcOperationalState.resume';
export const GO_HOME_KEY = 'RvcOperationalState.goHome';

/** mode 0 is Idle, mode 1 Cleaning — what a mapping's `map` and `format` name */
export const RUN_MODES = [
    {label: 'Idle', mode: 0, modeTags: [{value: RvcRunMode.ModeTag.Idle}]},
    {label: 'Cleaning', mode: 1, modeTags: [{value: RvcRunMode.ModeTag.Cleaning}]},
];

const {OperationalState: State} = RvcOperationalState;

export const OPERATIONAL_STATES = [
    State.Stopped,
    State.Running,
    State.Paused,
    State.Error,
    State.SeekingCharger,
    State.Charging,
    State.Docked,
].map((operationalStateId) => ({operationalStateId}));

export function runModeDefaults(): Record<string, unknown> {
    return {supportedModes: RUN_MODES, currentMode: 0};
}

export function operationalStateDefaults(): Record<string, unknown> {
    return {
        operationalStateList: OPERATIONAL_STATES,
        operationalState: State.Docked,
        operationalError: {errorStateId: OperationalState.ErrorState.NoError},
        phaseList: null,
        currentPhase: null,
    };
}

export class RvcRunModeServer extends BaseRvcRunModeServer {
    override async changeToMode({newMode}: ModeBase.ChangeToModeRequest): Promise<ModeBase.ChangeToModeResponse> {
        const result = ModeUtils.assertModeChange(this.state.supportedModes, this.state.currentMode, newMode);
        if (result.status !== ModeBase.ModeChangeStatus.Success) {
            return result;
        }
        if (await route(this.endpoint, RUN_MODE_KEY, newMode)) {
            await lock(this);
            this.state.currentMode = newMode;
        }
        return result;
    }
}

const accepted = {commandResponseState: {errorStateId: OperationalState.ErrorState.NoError}};
const refused = {commandResponseState: {errorStateId: OperationalState.ErrorState.CommandInvalidInState}};

/** OperationCompletion is optional in the base cluster and mandatory for a vacuum */
const OperationalStateBase = BaseRvcOperationalStateServer.enable({events: {operationCompletion: true}});

export class RvcOperationalStateServer extends OperationalStateBase {
    async #invoke(key: string, applied: RvcOperationalState.OperationalState): Promise<typeof accepted> {
        if (!hasCommand(contextOf(this.endpoint), key)) {
            return refused;
        }
        if (await route(this.endpoint, key, true)) {
            await lock(this);
            this.state.operationalState = applied;
        }
        return accepted;
    }

    override pause(): Promise<typeof accepted> {
        return this.#invoke(PAUSE_KEY, State.Paused);
    }

    override resume(): Promise<typeof accepted> {
        return this.#invoke(RESUME_KEY, State.Running);
    }

    override goHome(): Promise<typeof accepted> {
        return this.#invoke(GO_HOME_KEY, State.SeekingCharger);
    }
}
