export interface SessionShard {
    readonly index: number;
    readonly count: number;
}

export function sessionShardIndex(sessionId: string, count: number): number {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid session shard count");
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(sessionId)) {
        hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    return hash % count;
}

export function belongsToSessionShard(sessionId: string, shard: SessionShard): boolean {
    if (!Number.isSafeInteger(shard.index) || shard.index < 0 || shard.index >= shard.count) {
        throw new Error("Invalid session shard index");
    }
    return sessionShardIndex(sessionId, shard.count) === shard.index;
}
