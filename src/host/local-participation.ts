import type { InboxEntry } from "../store/inbox.ts";

export const PEER_MESSAGE_KIND = "peer.message";
export const PEER_READ_KIND = "peer.read";
export const VERA_INBOX_SOURCE = "vera";

export interface PeerMessagePayload {
    readonly version: 1;
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly reply_to?: number;
}

export interface PeerReadPayload {
    readonly message_id: number;
    readonly complete: true;
}

export function parsePeerMessage(entry: InboxEntry): PeerMessagePayload | undefined {
    if (
        entry.source !== VERA_INBOX_SOURCE
        || entry.kind !== PEER_MESSAGE_KIND
        || entry.actor === null
        || entry.address === null
    ) {
        return undefined;
    }
    const value = parseObject(entry.payload);
    if (
        value === undefined
        || value.version !== 1
        || typeof value.from !== "string"
        || value.from !== entry.actor
        || typeof value.to !== "string"
        || value.to !== entry.address
        || typeof value.text !== "string"
        || (
            value.reply_to !== undefined
            && (!Number.isSafeInteger(value.reply_to) || (value.reply_to as number) <= 0)
        )
    ) {
        return undefined;
    }
    return {
        version: 1,
        from: value.from,
        to: value.to,
        text: value.text,
        ...(value.reply_to === undefined
            ? {}
            : { reply_to: value.reply_to as number }),
    };
}

export function parsePeerRead(entry: InboxEntry): PeerReadPayload | undefined {
    if (
        entry.source !== VERA_INBOX_SOURCE
        || entry.kind !== PEER_READ_KIND
        || entry.actor === null
        || entry.address === null
    ) {
        return undefined;
    }
    const value = parseObject(entry.payload);
    return value !== undefined
            && Number.isSafeInteger(value.message_id)
            && (value.message_id as number) > 0
            && value.complete === true
        ? { message_id: value.message_id as number, complete: true }
        : undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
