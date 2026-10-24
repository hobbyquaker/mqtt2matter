/* The lock family: DoorLock. lock/unlock/unbolt publish through the `DoorLock.lockState` command half
   (its format map keyed by the state names `Locked`, `Unlocked`, `Unlatched`) and apply locally only when
   the mapping says so; matter.js' own actuation path is bypassed because it needs a remote fabric and
   writes the state unconditionally. Status: `lockState` is a plain enum (`Locked`, `Unlocked`,
   `NotFullyLocked` for jammed, `Unlatched`). No credentials, schedules or users: the lock is the device's. */

import {DoorLockServer as BaseDoorLockServer} from '@matter/main/behaviors/door-lock';
import {DoorLock} from '@matter/main/clusters/door-lock';

import {lock, route} from './registry.ts';

export const LOCK_STATE_KEY = 'DoorLock.lockState';

const {LockState} = DoorLock;

export class DoorLockServer extends BaseDoorLockServer {
    private async actuate(target: DoorLock.LockState, name: string): Promise<void> {
        if (await route(this.endpoint, LOCK_STATE_KEY, target, {name, action: name.toLowerCase()})) {
            await lock(this);
            this.state.lockState = target;
        }
    }

    override async lockDoor(_request: DoorLock.LockDoorRequest): Promise<void> {
        await this.actuate(LockState.Locked, 'Locked');
    }

    override async unlockDoor(_request: DoorLock.UnlockDoorRequest): Promise<void> {
        await this.actuate(LockState.Unlocked, 'Unlocked');
    }

    override async unlockWithTimeout(_request: DoorLock.UnlockWithTimeoutRequest): Promise<void> {
        await this.actuate(LockState.Unlocked, 'Unlocked');
    }

    async unboltDoor(_request: DoorLock.UnboltDoorRequest): Promise<void> {
        await this.actuate(LockState.Unlatched, 'Unlatched');
    }
}
