/* Device type names of the model → matter.js endpoint types, with the family behaviors that route
   controller commands to the runtime. Phase 0 knows the two on/off types the first device needs; phase 1
   replaces this table by a catalogue driven by @matter/model (every device type, its mandatory and
   optional clusters, the features from the endpoint's `features`). */

import type {EndpointType} from '@matter/main';
import {BridgedDeviceBasicInformationServer} from '@matter/main/behaviors/bridged-device-basic-information';
import {OnOffLightDevice} from '@matter/main/devices/on-off-light';
import {OnOffPlugInUnitDevice} from '@matter/main/devices/on-off-plug-in-unit';

import {OnOffServer} from '../families/on-off.ts';

const TYPES: Record<string, EndpointType> = {
    OnOffPlugInUnit: OnOffPlugInUnitDevice.with(OnOffServer, BridgedDeviceBasicInformationServer),
    OnOffLight: OnOffLightDevice.with(OnOffServer, BridgedDeviceBasicInformationServer),
};

export const SUPPORTED_DEVICE_TYPES: readonly string[] = Object.keys(TYPES);

/** the endpoint type for a model device type name; a name this phase does not know is an error */
export function endpointTypeFor(deviceTypes: readonly string[]): EndpointType {
    const [primary, ...rest] = deviceTypes;
    if (primary === undefined) {
        throw new Error('an endpoint needs at least one device type');
    }
    if (rest.length > 0) {
        throw new Error(`several device types on one endpoint (${deviceTypes.join(', ')}) are not supported yet`);
    }
    const type = TYPES[primary];
    if (type === undefined) {
        throw new Error(
            `device type "${primary}" is not supported yet; this build knows ${SUPPORTED_DEVICE_TYPES.join(', ')}`,
        );
    }
    return type;
}
