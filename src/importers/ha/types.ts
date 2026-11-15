/* The shapes of Home Assistant MQTT discovery (https://www.home-assistant.io/integrations/mqtt/): a
   retained JSON config per entity on `<prefix>/<component>/[<node_id>/]<object_id>/config`, or the
   device-based form on `<prefix>/device/[<node_id>/]<object_id>/config` whose `components` each carry a
   `platform`. Keys may be abbreviated (`stat_t` for `state_topic`); `~` stands for a prefix at the start
   or end of every `*_topic` value; an empty retained payload removes the config. The tables are Home
   Assistant's `abbreviations.py`; the importer expands everything once and works on the long names. */

export {
    ABBREVIATIONS,
    DEVICE_ABBREVIATIONS,
    ORIGIN_ABBREVIATIONS,
    expandEntity,
    expandDevicePayload,
    parseDiscoveryTopic,
    deviceIdentity,
} from 'mqtt-ha-entities';
export type {DeviceInfo, Origin, AvailabilityEntry, EntityConfig, DiscoveryTopic} from 'mqtt-ha-entities';
