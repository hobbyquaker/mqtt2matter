/* The few clusters whose mandatory attributes have no default in the model, or that need a feature chosen
   before matter.js accepts them (an occupancy sensor's detector type, a concentration cluster's numeric
   feature). Everything else matter.js and the families default; the config's `attributes` override all
   of it. Sensors have no family, so their needs live here. */

import {AirQuality} from '@matter/main/clusters/air-quality';
import {ConcentrationMeasurement} from '@matter/main/clusters/concentration-measurement';
import {DoorLock} from '@matter/main/clusters/door-lock';
import {OccupancySensing} from '@matter/main/clusters/occupancy-sensing';

export interface ClusterDefaults {
    /** features chosen when neither the device type, a family nor the config chose any */
    features?: readonly string[];
    attributes?: (features: ReadonlySet<string>) => Record<string, unknown>;
}

const concentration = (unit: ConcentrationMeasurement.MeasurementUnit): ClusterDefaults => ({
    features: ['NumericMeasurement'],
    attributes: () => ({
        measuredValue: null,
        measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
        measurementUnit: unit,
    }),
});

export const CLUSTER_DEFAULTS: Readonly<Record<string, ClusterDefaults>> = {
    OccupancySensing: {
        features: ['PassiveInfrared'],
        attributes: (features) => ({
            occupancy: {occupied: false},
            occupancySensorType: features.has('Ultrasonic')
                ? OccupancySensing.OccupancySensorType.Ultrasonic
                : features.has('PhysicalContact')
                  ? OccupancySensing.OccupancySensorType.PhysicalContact
                  : OccupancySensing.OccupancySensorType.Pir,
            occupancySensorTypeBitmap: {
                pir:
                    features.has('PassiveInfrared') || !(features.has('Ultrasonic') || features.has('PhysicalContact')),
                ultrasonic: features.has('Ultrasonic'),
                physicalContact: features.has('PhysicalContact'),
            },
        }),
    },
    DoorLock: {
        attributes: () => ({
            lockType: DoorLock.LockType.DeadBolt,
            lockState: DoorLock.LockState.Unlocked,
            actuatorEnabled: true,
            operatingMode: DoorLock.OperatingMode.Normal,
        }),
    },
    AirQuality: {
        features: ['Fair', 'Moderate', 'VeryPoor', 'ExtremelyPoor'],
        attributes: () => ({airQuality: AirQuality.AirQualityEnum.Unknown}),
    },
    CarbonDioxideConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppm),
    CarbonMonoxideConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppm),
    NitrogenDioxideConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppb),
    OzoneConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppb),
    FormaldehydeConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppb),
    TotalVolatileOrganicCompoundsConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ppb),
    Pm1ConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ugm3),
    Pm25ConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ugm3),
    Pm10ConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Ugm3),
    RadonConcentrationMeasurement: concentration(ConcentrationMeasurement.MeasurementUnit.Bqm3),
    BooleanState: {attributes: () => ({stateValue: false})},
    TemperatureMeasurement: {attributes: () => ({measuredValue: null})},
    RelativeHumidityMeasurement: {attributes: () => ({measuredValue: null})},
    IlluminanceMeasurement: {attributes: () => ({measuredValue: null})},
    PressureMeasurement: {attributes: () => ({measuredValue: null})},
    FlowMeasurement: {attributes: () => ({measuredValue: null})},
};
