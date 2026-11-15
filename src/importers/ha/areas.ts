/* Home Assistant's `suggested_area` onto Matter's Common Area semantic tags (namespace 0x10): a name that
   matches a tag — in English or German — becomes a Descriptor tag on the device's own endpoint; any other
   name is only carried in the discovery report. The table lives in mqtt-ha-entities;
   test/ha-areas.test.ts checks its ids against matter.js. */

export {areaTag, AREA_TAGS} from 'mqtt-ha-entities';
