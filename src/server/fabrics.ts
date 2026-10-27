/* What the Bridges page shows of a fabric: the controller by its root vendor id, the ids, and the
   sessions matter.js holds for it. A fabric is one controller's (one ecosystem's) pairing of the bridge;
   the vendor id of its root certificate names the ecosystem. The table holds the controllers people pair
   bridges with; every id is the one the CSA's Distributed Compliance Ledger lists for that vendor. */

/** root vendor id → the controller's name */
export const CONTROLLERS: ReadonlyMap<number, string> = new Map([
    [0x1349, 'Apple Home'],
    // Apple adds a second fabric for the iCloud Keychain when the bridge is paired from Apple Home
    [0x1384, 'Apple Keychain'],
    [0x6006, 'Google Home'],
    [0x1217, 'Amazon Alexa'],
    [0x134b, 'Home Assistant'],
    [0x110a, 'Samsung SmartThings'],
    [0x115f, 'Aqara'],
    [0x117c, 'IKEA'],
    [0x100b, 'Philips Hue (Signify)'],
    [0x125d, 'Tuya'],
    [0x126e, 'Xiaomi'],
    [0x1286, 'eWeLink (CoolKit)'],
    [0x1490, 'Shelly'],
    [0x1488, 'Flic'],
    // the test vendor ids of the specification: chip-tool, matter.js' own controller, development builds
    [0xfff1, 'Test vendor'],
    [0xfff2, 'Test vendor'],
    [0xfff3, 'Test vendor'],
    [0xfff4, 'Test vendor'],
]);

export function controllerName(vendorId: number): string | undefined {
    return CONTROLLERS.get(vendorId);
}

/** a fabric as matter.js' FabricManager has it (the fields read here) */
export interface FabricSource {
    fabricIndex: number;
    fabricId: bigint | number;
    nodeId: bigint | number;
    rootNodeId: bigint | number;
    rootVendorId: number;
    globalId: bigint | number;
    label: string;
}

/** a session as matter.js' SessionsBehavior has it (the fields read here) */
export interface SessionSource {
    fabric?: {fabricIndex: number} | undefined;
    isPeerActive: boolean;
    lastInteractionTimestamp: number | undefined;
    numberOfActiveSubscriptions: number;
}

export interface FabricJson {
    index: number;
    label: string;
    vendorId: number;
    /** the controller, when the vendor id is a known one */
    vendorName: string | undefined;
    /** the bridge's node id in this fabric */
    nodeId: string;
    /** the controller's own node id (the root's) */
    rootNodeId: string;
    fabricId: string;
    /** the compressed fabric id, hex: the first half of the bridge's operational mDNS name in this fabric */
    compressedFabricId: string;
    /** sessions of the controller whose peer is active */
    sessions: number;
    subscriptions: number;
    /** ms since the epoch: the last interaction over any session of this fabric */
    lastInteraction: number | undefined;
}

const hex16 = (value: bigint | number): string => BigInt(value).toString(16).toUpperCase().padStart(16, '0');

export function fabricJson(fabric: FabricSource, sessions: readonly SessionSource[]): FabricJson {
    const own = sessions.filter((s) => s.fabric?.fabricIndex === fabric.fabricIndex);
    const active = own.filter((s) => s.isPeerActive);
    const last = own.map((s) => s.lastInteractionTimestamp ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return {
        index: fabric.fabricIndex,
        label: fabric.label,
        vendorId: fabric.rootVendorId,
        vendorName: controllerName(fabric.rootVendorId),
        nodeId: String(fabric.nodeId),
        rootNodeId: String(fabric.rootNodeId),
        fabricId: String(fabric.fabricId),
        compressedFabricId: hex16(fabric.globalId),
        sessions: active.length,
        subscriptions: own.reduce((sum, s) => sum + s.numberOfActiveSubscriptions, 0),
        lastInteraction: last > 0 ? last : undefined,
    };
}
