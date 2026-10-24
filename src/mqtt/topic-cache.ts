/* The last payload per topic. The UI's live view and the importers read it (phase 2–4); the runtime
   does not need it, but every message passes through here so a binding added later sees the retained
   state at once. MQTT wildcard matching lives here too. */

export interface CachedMessage {
    topic: string;
    payload: Buffer;
    retain: boolean;
    /** ms since epoch */
    ts: number;
}

/** does `filter` (with `+` and `#`) match `topic`? */
export function topicMatches(filter: string, topic: string): boolean {
    if (filter === topic) {
        return true;
    }
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        const part = f[i];
        if (part === '#') {
            return true;
        }
        if (i >= t.length) {
            return false;
        }
        if (part !== '+' && part !== t[i]) {
            return false;
        }
    }
    return f.length === t.length;
}

export class TopicCache {
    private readonly messages = new Map<string, CachedMessage>();
    private readonly limit: number;

    constructor(limit = 10_000) {
        this.limit = limit;
    }

    get size(): number {
        return this.messages.size;
    }

    store(topic: string, payload: Buffer, retain: boolean, ts = Date.now()): CachedMessage {
        const message: CachedMessage = {topic, payload, retain, ts};
        if (!this.messages.has(topic) && this.messages.size >= this.limit) {
            // the oldest entry goes; insertion order is the map's order
            const oldest = this.messages.keys().next().value;
            if (oldest !== undefined) {
                this.messages.delete(oldest);
            }
        }
        this.messages.delete(topic);
        this.messages.set(topic, message);
        return message;
    }

    get(topic: string): CachedMessage | undefined {
        return this.messages.get(topic);
    }

    /** every cached message whose topic matches the filter */
    match(filter: string): CachedMessage[] {
        return [...this.messages.values()].filter((m) => topicMatches(filter, m.topic));
    }

    topics(): string[] {
        return [...this.messages.keys()];
    }
}
