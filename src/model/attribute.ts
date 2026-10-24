/* `Cluster.attribute` references and matter.js' naming: the behavior id of a cluster is its name in
   lower camel case (`OnOff` → `onOff`, `LevelControl` → `levelControl`), the attribute name is used as is. */

import {ATTRIBUTE_PATTERN} from './schema.ts';

export interface AttributeRef {
    /** the cluster in matter.js' PascalCase, e.g. `OnOff` */
    readonly cluster: string;
    /** the attribute in lower camel case, e.g. `onOff` */
    readonly attribute: string;
    /** the behavior id matter.js uses as the state key, e.g. `onOff` */
    readonly behaviorId: string;
}

export function parseAttribute(text: string): AttributeRef {
    if (!ATTRIBUTE_PATTERN.test(text)) {
        throw new Error(`invalid attribute reference "${text}" (expected Cluster.attribute, e.g. OnOff.onOff)`);
    }
    const [cluster, attribute] = text.split('.') as [string, string];
    return {cluster, attribute, behaviorId: cluster.charAt(0).toLowerCase() + cluster.slice(1)};
}

export function attributeKey(ref: AttributeRef): string {
    return `${ref.cluster}.${ref.attribute}`;
}
