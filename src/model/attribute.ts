/* `Cluster.attribute` and `Cluster.command` references and matter.js' naming: the behavior id of a cluster
   is its name in lower camel case (`OnOff` → `onOff`, `LevelControl` → `levelControl`), the attribute or
   command name is used as is. */

import {ATTRIBUTE_PATTERN} from './schema.ts';

export interface AttributeRef {
    /** the cluster in matter.js' PascalCase, e.g. `OnOff` */
    readonly cluster: string;
    /** the attribute in lower camel case, e.g. `onOff` */
    readonly attribute: string;
    /** the behavior id matter.js uses as the state key, e.g. `onOff` */
    readonly behaviorId: string;
}

export interface CommandRef {
    readonly cluster: string;
    /** the command in lower camel case, e.g. `stopMotion` */
    readonly command: string;
    readonly behaviorId: string;
}

function behaviorIdOf(cluster: string): string {
    return cluster.charAt(0).toLowerCase() + cluster.slice(1);
}

export function parseAttribute(text: string): AttributeRef {
    if (!ATTRIBUTE_PATTERN.test(text)) {
        throw new Error(`invalid attribute reference "${text}" (expected Cluster.attribute, e.g. OnOff.onOff)`);
    }
    const [cluster, attribute] = text.split('.') as [string, string];
    return {cluster, attribute, behaviorId: behaviorIdOf(cluster)};
}

export function parseCommand(text: string): CommandRef {
    if (!ATTRIBUTE_PATTERN.test(text)) {
        throw new Error(
            `invalid command reference "${text}" (expected Cluster.command, e.g. WindowCovering.stopMotion)`,
        );
    }
    const [cluster, command] = text.split('.') as [string, string];
    return {cluster, command, behaviorId: behaviorIdOf(cluster)};
}

export function attributeKey(ref: AttributeRef): string {
    return `${ref.cluster}.${ref.attribute}`;
}

export function commandKey(ref: CommandRef): string {
    return `${ref.cluster}.${ref.command}`;
}
