/* Baseline + patch: an importer generates a device (the baseline) from a foreign description; the user
   edits the result; when the description changes, the baseline is regenerated and the user's edits are
   reapplied. The edits are the difference between the old baseline and the device as it is now, taken
   over a *keyed tree* of the device: endpoints by their id, bindings by their target, so a binding keeps
   its edits when the importer reorders or adds bindings. A conflict is a changed value on a path the new
   baseline changed too; it is reported, never silently resolved (the edit still wins, so nothing the user
   wrote is lost — the report says what the importer would have written). What the user removed stays
   removed. Nothing here knows about zigbee2mqtt. */

import type {BindingInput, DeviceInput, EndpointInput} from '../model/schema.ts';

export type Path = readonly string[];

export type Op = {op: 'set'; path: Path; value: unknown} | {op: 'delete'; path: Path};

export interface Conflict {
    /** `endpoints.l1.bindings.attribute:OnOff.onOff.status.topic` */
    path: string;
    op: 'set' | 'delete';
    /** what the user's edit put there (set) */
    user?: unknown;
    /** the old baseline's value */
    before?: unknown;
    /** the new baseline's value — what the importer would have written */
    now?: unknown;
    /** false when the edit could not be applied (its parent disappeared from the baseline) */
    applied: boolean;
    reason: string;
}

type Tree = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    }
    if (isRecord(a) && isRecord(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
    }
    return false;
}

/** the key of a binding in the tree: its target, with a counter for a repeated target */
function bindingKey(binding: BindingInput, seen: Map<string, number>): string {
    const target =
        'attribute' in binding
            ? `attribute:${binding.attribute}`
            : 'invoke' in binding
              ? `invoke:${binding.invoke}`
              : `event:${binding.event}`;
    const n = (seen.get(target) ?? 0) + 1;
    seen.set(target, n);
    return n === 1 ? target : `${target}#${n}`;
}

export const MAIN_ENDPOINT = 'main';

/** the keyed tree: endpoints by id, bindings by target; `source` left out (it is the importer's) */
export function toTree(device: DeviceInput): Tree {
    const {endpoints, ...rest} = device;
    const tree: Tree = structuredClone(rest);
    delete tree.source;
    const byId: Tree = {};
    for (const endpoint of endpoints) {
        const {bindings, ...endpointRest} = endpoint;
        const seen = new Map<string, number>();
        const byTarget: Tree = {};
        for (const binding of bindings ?? []) {
            byTarget[bindingKey(binding, seen)] = structuredClone(binding);
        }
        byId[endpoint.id ?? MAIN_ENDPOINT] = {...structuredClone(endpointRest), bindings: byTarget};
    }
    tree.endpoints = byId;
    return tree;
}

/** back to the array form; `order` says which endpoints and bindings come first (the baseline's order) */
export function fromTree(tree: Tree, order?: Tree): DeviceInput {
    const {endpoints, ...rest} = tree;
    const result = structuredClone(rest) as DeviceInput;
    const list: EndpointInput[] = [];
    const endpointIds = orderedKeys(
        isRecord(endpoints) ? endpoints : {},
        isRecord(order?.endpoints) ? order.endpoints : {},
    );
    for (const id of endpointIds) {
        const node = isRecord(endpoints) ? endpoints[id] : undefined;
        if (!isRecord(node)) {
            continue;
        }
        const {bindings, ...endpointRest} = node;
        const orderNode = isRecord(order?.endpoints) ? order.endpoints[id] : undefined;
        const bindingOrder = isRecord(orderNode) && isRecord(orderNode.bindings) ? orderNode.bindings : {};
        const bindingList: BindingInput[] = [];
        if (isRecord(bindings)) {
            for (const key of orderedKeys(bindings, bindingOrder)) {
                const binding = bindings[key];
                if (isRecord(binding)) {
                    bindingList.push(structuredClone(binding) as BindingInput);
                }
            }
        }
        const endpoint = {...structuredClone(endpointRest), bindings: bindingList} as EndpointInput;
        if (id !== MAIN_ENDPOINT) {
            endpoint.id = id;
        }
        list.push(endpoint);
    }
    result.endpoints = list;
    return result;
}

function orderedKeys(tree: Tree, order: Tree): string[] {
    const keys = Object.keys(order).filter((k) => k in tree);
    for (const key of Object.keys(tree)) {
        if (!keys.includes(key)) {
            keys.push(key);
        }
    }
    return keys;
}

/** the edits that turn `base` into `current`: sets of changed or added leaves and subtrees, deletes of removed ones */
export function diffTrees(base: unknown, current: unknown, path: Path = []): Op[] {
    const ops: Op[] = [];
    if (isRecord(base) && isRecord(current)) {
        for (const key of Object.keys(base)) {
            if (!(key in current)) {
                ops.push({op: 'delete', path: [...path, key]});
            }
        }
        for (const [key, value] of Object.entries(current)) {
            if (key in base) {
                ops.push(...diffTrees(base[key], value, [...path, key]));
            } else {
                ops.push({op: 'set', path: [...path, key], value: structuredClone(value)});
            }
        }
        return ops;
    }
    if (!deepEqual(base, current)) {
        ops.push({op: 'set', path, value: structuredClone(current)});
    }
    return ops;
}

function getPath(tree: unknown, path: Path): unknown {
    let cursor = tree;
    for (const key of path) {
        if (!isRecord(cursor)) {
            return undefined;
        }
        cursor = cursor[key];
    }
    return cursor;
}

function hasPath(tree: unknown, path: Path): boolean {
    let cursor = tree;
    for (const key of path) {
        if (!isRecord(cursor) || !(key in cursor)) {
            return false;
        }
        cursor = cursor[key];
    }
    return true;
}

function setPath(tree: Tree, path: Path, value: unknown): void {
    let cursor: Tree = tree;
    for (const key of path.slice(0, -1)) {
        const next = cursor[key];
        if (!isRecord(next)) {
            const created: Tree = {};
            cursor[key] = created;
            cursor = created;
        } else {
            cursor = next;
        }
    }
    const last = path.at(-1);
    if (last !== undefined) {
        cursor[last] = value;
    }
}

function deletePath(tree: Tree, path: Path): void {
    const parent = getPath(tree, path.slice(0, -1));
    const last = path.at(-1);
    if (isRecord(parent) && last !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete parent[last];
    }
}

/** reapply the edits on the new baseline; an edit on a path the baseline changed too is a conflict */
export function applyOps(ops: readonly Op[], oldBase: Tree, newBase: Tree): {tree: Tree; conflicts: Conflict[]} {
    const tree = structuredClone(newBase);
    const conflicts: Conflict[] = [];
    for (const op of ops) {
        const before = getPath(oldBase, op.path);
        const now = getPath(newBase, op.path);
        const baseChanged = !deepEqual(before, now);
        const dotted = op.path.join('.');
        if (op.op === 'set') {
            const parent = op.path.slice(0, -1);
            if (parent.length > 0 && !hasPath(newBase, parent) && hasPath(oldBase, parent)) {
                conflicts.push({
                    path: dotted,
                    op: 'set',
                    user: op.value,
                    before,
                    applied: false,
                    reason: 'the importer no longer generates what this edit belongs to',
                });
                continue;
            }
            if (baseChanged) {
                conflicts.push({
                    path: dotted,
                    op: 'set',
                    user: op.value,
                    before,
                    now,
                    applied: true,
                    reason: 'the importer changed this value too; the edit was kept',
                });
            }
            setPath(tree, op.path, structuredClone(op.value));
        } else if (hasPath(newBase, op.path)) {
            // what the user removed stays removed, whatever the importer did to it since
            deletePath(tree, op.path);
        }
    }
    return {tree, conflicts};
}

export interface Resync {
    device: DeviceInput;
    /** the user's edits, as found against the old baseline */
    edits: Op[];
    conflicts: Conflict[];
}

/** the new baseline with the user's edits (current − old baseline) reapplied */
export function resync(oldBaseline: DeviceInput, current: DeviceInput, newBaseline: DeviceInput): Resync {
    const oldTree = toTree(oldBaseline);
    const newTree = toTree(newBaseline);
    const edits = diffTrees(oldTree, toTree(current));
    const {tree, conflicts} = applyOps(edits, oldTree, newTree);
    const device = fromTree(tree, newTree);
    if (current.source !== undefined) {
        device.source = structuredClone(current.source);
    }
    return {device, edits, conflicts};
}

/** the user's edits of `current` against its baseline (for a display, or to tell an untouched device) */
export function editsOf(baseline: DeviceInput, current: DeviceInput): Op[] {
    return diffTrees(toTree(baseline), toTree(current));
}
